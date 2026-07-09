import { createClient } from '@/lib/supabase/server';
import { dbToAccount, isPendingIbkrId, PENDING_IBKR_PREFIX } from '@/lib/account-mapper';
import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('user_id', user.id)
    .order('display_name', { ascending: true });

  if (error) {
    if (error.code === '42P01') {
      return NextResponse.json(
        { error: 'Table comptes manquante — rechargez /api/setup?secret=...' },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: counts } = await supabase
    .from('statements')
    .select('portfolio_account_id')
    .eq('user_id', user.id);

  const countMap = new Map<string, number>();
  for (const row of counts ?? []) {
    if (row.portfolio_account_id) {
      countMap.set(
        row.portfolio_account_id,
        (countMap.get(row.portfolio_account_id) ?? 0) + 1,
      );
    }
  }

  return NextResponse.json(
    (data ?? []).map((row) => {
      const acc = dbToAccount(row);
      acc.statementCount = countMap.get(acc.id) ?? 0;
      return acc;
    }),
  );
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const body = await request.json();
  const ibkrInput = (body.ibkrAccountId as string | undefined)?.trim();
  const displayName = (body.displayName as string)?.trim();

  if (!displayName) {
    return NextResponse.json({ error: 'Nom du compte requis' }, { status: 400 });
  }

  const ibkrAccountId = ibkrInput || `${PENDING_IBKR_PREFIX}${randomUUID()}`;

  const { data, error } = await supabase
    .from('accounts')
    .insert({
      user_id: user.id,
      ibkr_account_id: ibkrAccountId,
      display_name: displayName,
      notes: body.notes ?? '',
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(dbToAccount(data));
}

export async function PATCH(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const body = await request.json();
  const id = body.id as string;
  if (!id) return NextResponse.json({ error: 'ID requis' }, { status: 400 });

  const updates: Record<string, string> = { updated_at: new Date().toISOString() };
  if (body.displayName) updates.display_name = body.displayName.trim();
  if (body.notes !== undefined) updates.notes = body.notes;

  if (body.ibkrAccountId !== undefined) {
    const ibkrAccountId = (body.ibkrAccountId as string).trim();
    if (!ibkrAccountId) {
      return NextResponse.json({ error: 'ID IBKR invalide' }, { status: 400 });
    }
    updates.ibkr_account_id = ibkrAccountId;
  }

  const { data, error } = await supabase
    .from('accounts')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(dbToAccount(data));
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'ID requis' }, { status: 400 });

  const { data: account } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (!account) return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });

  await supabase
    .from('statements')
    .delete()
    .eq('user_id', user.id)
    .eq('portfolio_account_id', id);

  await supabase
    .from('nav_series')
    .delete()
    .eq('user_id', user.id)
    .eq('portfolio_account_id', id);

  const { error } = await supabase.from('accounts').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
