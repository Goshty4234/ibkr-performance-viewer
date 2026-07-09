import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { data, error } = await supabase
    .from('statements')
    .select('*')
    .order('period_start', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const body = await request.json();

  const { data, error } = await supabase
    .from('statements')
    .upsert({
      user_id: user.id,
      account_id: body.accountId,
      account_alias: body.accountAlias,
      base_currency: body.baseCurrency,
      period_start: body.periodStart,
      period_end: body.periodEnd,
      starting_nav: body.startingNav,
      ending_nav: body.endingNav,
      twrr: body.twrr,
      filename: body.filename,
      cash_flows: body.cashFlows,
      imported_at: new Date().toISOString(),
    }, { onConflict: 'user_id,account_id,period_start,period_end' })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'ID requis' }, { status: 400 });

  const { error } = await supabase.from('statements').delete().eq('id', id).eq('user_id', user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
