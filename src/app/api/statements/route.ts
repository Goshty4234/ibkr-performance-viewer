import { createClient } from '@/lib/supabase/server';
import { ensureTwrDailyColumn } from '@/lib/db-migrate';
import { dbToStatement } from '@/lib/db-mapper';
import {
  sanitizeStatementForClient,
  sanitizeStatementForStorage,
} from '@/lib/privacy';
import { findStatementsToReplaceOnImport } from '@/lib/statements';
import { verifyCsvAccountForPortfolio } from '@/lib/verify-csv-account';
import type { DbStatement } from '@/lib/types';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const portfolioAccountId = searchParams.get('portfolioAccountId');

  let query = supabase
    .from('statements')
    .select('*')
    .eq('user_id', user.id)
    .order('period_start', { ascending: true });

  if (portfolioAccountId) {
    query = query.eq('portfolio_account_id', portfolioAccountId);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    (data ?? []).map((row) => sanitizeStatementForClient(dbToStatement(row))),
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const body = await request.json();
  const portfolioAccountId = body.portfolioAccountId as string | undefined;
  const accountId = body.accountId as string;
  const periodStart = body.periodStart as string;
  const periodEnd = body.periodEnd as string;

  if (Array.isArray(body.twrDaily) && body.twrDaily.length > 0) {
    await ensureTwrDailyColumn();
  }

  if (!portfolioAccountId) {
    return NextResponse.json({ error: 'Compte workspace requis' }, { status: 400 });
  }

  const verify = await verifyCsvAccountForPortfolio(
    supabase,
    user.id,
    portfolioAccountId,
    accountId,
  );
  if (!verify.ok) {
    return NextResponse.json({ error: verify.error }, { status: verify.status });
  }

  const sanitized = sanitizeStatementForStorage(body, user.id);

  const { data: existingRows } = await supabase
    .from('statements')
    .select('*')
    .eq('user_id', user.id)
    .eq('portfolio_account_id', portfolioAccountId);

  const existing = (existingRows ?? []).map(dbToStatement);
  const toReplace = findStatementsToReplaceOnImport(
    existing,
    portfolioAccountId,
    periodStart,
    periodEnd,
  );

  let replaced = 0;
  if (toReplace.length) {
    const ids = toReplace.map((s) => s.id);
    const { error: delErr } = await supabase
      .from('statements')
      .delete()
      .in('id', ids)
      .eq('user_id', user.id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    replaced = ids.length;
  }

  const isExactUpdate = existing.some(
    (s: DbStatement) =>
      s.portfolioAccountId === portfolioAccountId &&
      s.periodStart === periodStart &&
      s.periodEnd === periodEnd,
  );

  const row = {
    user_id: user.id,
    portfolio_account_id: portfolioAccountId,
    account_id: sanitized.accountId,
    account_alias: sanitized.accountAlias,
    base_currency: body.baseCurrency,
    period_start: periodStart,
    period_end: periodEnd,
    starting_nav: body.startingNav,
    ending_nav: body.endingNav,
    twrr: body.twrr,
    filename: sanitized.filename,
    cash_flows: sanitized.cashFlows,
    daily_events: body.dailyEvents ?? [],
    twr_daily: body.twrDaily ?? [],
    imported_at: new Date().toISOString(),
  };

  const rowWithoutTwrDaily = { ...row };
  delete (rowWithoutTwrDaily as { twr_daily?: unknown }).twr_daily;

  let twrDailyStored = true;
  let { data, error } = await supabase.from('statements').insert(row).select().single();
  if (error && /twr_daily/i.test(error.message)) {
    twrDailyStored = false;
    ({ data, error } = await supabase.from('statements').insert(rowWithoutTwrDaily).select().single());
  }

  if (error) {
    if (error.code === '23505') {
      let { data: updated, error: upErr } = await supabase
        .from('statements')
        .update(row)
        .eq('user_id', user.id)
        .eq('portfolio_account_id', portfolioAccountId)
        .eq('period_start', periodStart)
        .eq('period_end', periodEnd)
        .select()
        .single();
      if (upErr && /twr_daily/i.test(upErr.message)) {
        twrDailyStored = false;
        ({ data: updated, error: upErr } = await supabase
          .from('statements')
          .update(rowWithoutTwrDaily)
          .eq('user_id', user.id)
          .eq('portfolio_account_id', portfolioAccountId)
          .eq('period_start', periodStart)
          .eq('period_end', periodEnd)
          .select()
          .single());
      }
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
      return NextResponse.json({
        statement: sanitizeStatementForClient(dbToStatement(updated!)),
        meta: {
          replaced,
          action: 'updated',
          twrDailyStored,
          ...(twrDailyStored
            ? {}
            : { warning: 'Colonne twr_daily absente — lancez /api/setup?secret=...' }),
        },
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    statement: sanitizeStatementForClient(dbToStatement(data!)),
    meta: {
      replaced,
      action: replaced > 0 ? 'replaced_overlap' : isExactUpdate ? 'updated' : 'created',
      twrDailyStored,
      ...(twrDailyStored
        ? {}
        : { warning: 'Colonne twr_daily absente — lancez /api/setup?secret=...' }),
    },
  });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const portfolioAccountId = searchParams.get('portfolioAccountId');
  const rangeStart = searchParams.get('rangeStart');
  const rangeEnd = searchParams.get('rangeEnd');

  if (portfolioAccountId && rangeStart && rangeEnd) {
    const { data: rows } = await supabase
      .from('statements')
      .select('id, period_start, period_end')
      .eq('user_id', user.id)
      .eq('portfolio_account_id', portfolioAccountId);

    const toDelete = (rows ?? []).filter(
      (r) => r.period_start <= rangeEnd && r.period_end >= rangeStart,
    );

    if (!toDelete.length) {
      return NextResponse.json({ ok: true, deleted: 0 });
    }

    const { error } = await supabase
      .from('statements')
      .delete()
      .in('id', toDelete.map((r) => r.id))
      .eq('user_id', user.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: toDelete.length });
  }

  if (!id) return NextResponse.json({ error: 'ID ou plage requis' }, { status: 400 });

  const { error } = await supabase
    .from('statements')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: 1 });
}
