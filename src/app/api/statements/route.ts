import { createClient } from '@/lib/supabase/server';
import { dbToStatement } from '@/lib/db-mapper';
import { findStatementsToReplaceOnImport } from '@/lib/statements';
import type { DbStatement } from '@/lib/types';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const portfolioAccountId = searchParams.get('portfolioAccountId');
  const accountId = searchParams.get('accountId');

  let query = supabase
    .from('statements')
    .select('*')
    .eq('user_id', user.id)
    .order('period_start', { ascending: true });

  if (portfolioAccountId) {
    query = query.eq('portfolio_account_id', portfolioAccountId);
  } else if (accountId) {
    query = query.eq('account_id', accountId);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
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

  if (!portfolioAccountId) {
    return NextResponse.json({ error: 'Compte workspace requis' }, { status: 400 });
  }

  const { data: portfolioAccount } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', portfolioAccountId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!portfolioAccount) {
    return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
  }

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

  const { data, error } = await supabase
    .from('statements')
    .insert({
      user_id: user.id,
      portfolio_account_id: portfolioAccountId,
      account_id: accountId,
      account_alias: body.accountAlias,
      base_currency: body.baseCurrency,
      period_start: periodStart,
      period_end: periodEnd,
      starting_nav: body.startingNav,
      ending_nav: body.endingNav,
      twrr: body.twrr,
      filename: body.filename,
      cash_flows: body.cashFlows,
      daily_events: body.dailyEvents ?? [],
      imported_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      const { data: updated, error: upErr } = await supabase
        .from('statements')
        .update({
          account_id: accountId,
          account_alias: body.accountAlias,
          base_currency: body.baseCurrency,
          starting_nav: body.startingNav,
          ending_nav: body.endingNav,
          twrr: body.twrr,
          filename: body.filename,
          cash_flows: body.cashFlows,
          daily_events: body.dailyEvents ?? [],
          imported_at: new Date().toISOString(),
        })
        .eq('user_id', user.id)
        .eq('portfolio_account_id', portfolioAccountId)
        .eq('period_start', periodStart)
        .eq('period_end', periodEnd)
        .select()
        .single();
      if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
      return NextResponse.json({
        statement: updated,
        meta: { replaced, action: 'updated' },
      });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    statement: data,
    meta: {
      replaced,
      action: replaced > 0 ? 'replaced_overlap' : isExactUpdate ? 'updated' : 'created',
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
  const accountId = searchParams.get('accountId');
  const rangeStart = searchParams.get('rangeStart');
  const rangeEnd = searchParams.get('rangeEnd');

  const scopeId = portfolioAccountId ?? accountId;

  if (scopeId && rangeStart && rangeEnd) {
    let query = supabase
      .from('statements')
      .select('id, period_start, period_end')
      .eq('user_id', user.id);

    if (portfolioAccountId) {
      query = query.eq('portfolio_account_id', portfolioAccountId);
    } else {
      query = query.eq('account_id', accountId!);
    }

    const { data: rows } = await query;

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
