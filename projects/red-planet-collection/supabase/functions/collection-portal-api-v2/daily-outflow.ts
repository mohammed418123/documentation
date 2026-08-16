export type DailyOutflowSource = "expense" | "advance";

export type DailyOutflowInput = {
  source: DailyOutflowSource;
  date: string;
  amount: number;
  currency_id: number | null;
  status: string;
};

export type DailyOutflowRow = {
  date: string;
  currency_id: number | null;
  expense_total: number;
  expense_actual: number;
  expense_count: number;
  advance_total: number;
  advance_actual: number;
  advance_count: number;
  registered_total: number;
  actual_total: number;
  unposted_total: number;
};

const EXCLUDED_STATES = new Set(["rejected", "cancelled", "canceled"]);
const ACTUAL_EXPENSE_STATES = new Set(["approved", "posted", "paid"]);
const ACTUAL_ADVANCE_STATES = new Set(["posted"]);

export function aggregateDailyOutflows(rows: DailyOutflowInput[]) {
  const grouped = new Map<string, DailyOutflowRow>();
  for (const item of rows) {
    const state = String(item.status || "").trim().toLowerCase();
    const amount = Number(item.amount || 0);
    if (!item.date || !(amount > 0) || EXCLUDED_STATES.has(state)) continue;
    const currencyId = Number(item.currency_id || 0) || null;
    const key = `${item.date}|${currencyId || 0}`;
    const row = grouped.get(key) || {
      date: item.date,
      currency_id: currencyId,
      expense_total: 0,
      expense_actual: 0,
      expense_count: 0,
      advance_total: 0,
      advance_actual: 0,
      advance_count: 0,
      registered_total: 0,
      actual_total: 0,
      unposted_total: 0,
    };
    if (item.source === "expense") {
      row.expense_total += amount;
      row.expense_count += 1;
      if (ACTUAL_EXPENSE_STATES.has(state)) row.expense_actual += amount;
    } else {
      row.advance_total += amount;
      row.advance_count += 1;
      if (ACTUAL_ADVANCE_STATES.has(state)) row.advance_actual += amount;
    }
    grouped.set(key, row);
  }
  return [...grouped.values()]
    .map((row) => ({
      ...row,
      registered_total: row.expense_total + row.advance_total,
      actual_total: row.expense_actual + row.advance_actual,
      unposted_total:
        row.expense_total + row.advance_total - row.expense_actual - row.advance_actual,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || Number(a.currency_id) - Number(b.currency_id));
}

export function outflowTotals(rows: DailyOutflowRow[]) {
  return rows.reduce(
    (total, row) => ({
      expense_total: total.expense_total + row.expense_total,
      expense_actual: total.expense_actual + row.expense_actual,
      expense_count: total.expense_count + row.expense_count,
      advance_total: total.advance_total + row.advance_total,
      advance_actual: total.advance_actual + row.advance_actual,
      advance_count: total.advance_count + row.advance_count,
      registered_total: total.registered_total + row.registered_total,
      actual_total: total.actual_total + row.actual_total,
      unposted_total: total.unposted_total + row.unposted_total,
    }),
    {
      expense_total: 0,
      expense_actual: 0,
      expense_count: 0,
      advance_total: 0,
      advance_actual: 0,
      advance_count: 0,
      registered_total: 0,
      actual_total: 0,
      unposted_total: 0,
    },
  );
}
