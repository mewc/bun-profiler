/**
 * A realistic mixed CPU + I/O request pipeline.
 *
 * This is the most instructive workload in the demo. One request fans out into
 * a deep call tree where some branches burn CPU and others just wait on I/O:
 *
 *   handleCheckout
 *   ├── validateCart        CPU   ~11ms
 *   ├── loadCustomer        I/O    40ms   ← invisible in the cpu flamegraph
 *   ├── priceCart
 *   │   ├── applyDiscounts  CPU   ~23ms
 *   │   └── computeTax      CPU   ~19ms
 *   ├── reserveInventory    I/O    60ms   ← invisible in the cpu flamegraph
 *   ├── chargePayment       I/O    90ms   ← invisible in the cpu flamegraph
 *   └── renderReceipt       CPU   ~10ms
 *
 * The `cpu` flamegraph shows a request that costs ~60ms of compute, and points
 * at applyDiscounts as the hot spot.
 *
 * The `wall` flamegraph shows the same request actually takes ~250ms, and that
 * ~190ms of it is spent parked on I/O (bucketed into the "(idle)" frame — JSC
 * reports nothing while the process is waiting, so the wait cannot be pinned to
 * chargePayment specifically).
 *
 * Optimising applyDiscounts is what the CPU profile tells you to do. The wall
 * profile tells you the real win is making those three I/O calls concurrent.
 */

import { sleep } from "./io.ts";

export interface CartLine {
  sku: string;
  quantity: number;
  unitCents: number;
}

export interface Receipt {
  customerId: string;
  lines: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

export function buildCart(lines: number): CartLine[] {
  const cart: CartLine[] = new Array(lines);
  for (let i = 0; i < lines; i++) {
    cart[i] = {
      sku: `SKU-${(i * 7919).toString(36).toUpperCase()}`,
      quantity: (i % 4) + 1,
      unitCents: 500 + ((i * 137) % 9500),
    };
  }
  return cart;
}

/** CPU: per-line schema + business-rule checks. */
export function validateCart(cart: CartLine[]): number {
  let checked = 0;
  for (let round = 0; round < 17_000; round++) {
    for (const line of cart) {
      if (!/^SKU-[0-9A-Z]+$/.test(line.sku)) throw new Error(`bad sku ${line.sku}`);
      if (line.quantity <= 0 || line.quantity > 100) throw new Error("bad quantity");
      if (!Number.isInteger(line.unitCents)) throw new Error("bad price");
      checked++;
    }
  }
  return checked;
}

/** I/O: fetch the customer record. */
async function loadCustomer(customerId: string): Promise<{ id: string; tier: string }> {
  await sleep(40);
  return { id: customerId, tier: customerId.endsWith("9") ? "gold" : "standard" };
}

/** CPU: the hot spot the cpu flamegraph will point you at. */
export function applyDiscounts(cart: CartLine[], tier: string): number {
  const tierMultiplier = tier === "gold" ? 0.85 : 0.95;
  let discount = 0;
  // Deliberately quadratic — bundle rules compared pairwise.
  for (let round = 0; round < 3_000; round++) {
    discount = 0;
    for (const line of cart) {
      for (const other of cart) {
        if (line.sku === other.sku) continue;
        if (line.unitCents > other.unitCents) {
          discount += Math.round(line.unitCents * (1 - tierMultiplier) * 0.001);
        }
      }
    }
  }
  return discount;
}

/** CPU: jurisdictional tax rules. */
export function computeTax(subtotalCents: number, cart: CartLine[]): number {
  const ROUNDS = 170_000;
  let tax = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const line of cart) {
      const rate = 0.05 + (line.sku.charCodeAt(4) % 7) / 100;
      tax += line.unitCents * line.quantity * rate;
    }
  }
  return Math.round(tax / ROUNDS);
}

function priceCart(cart: CartLine[], tier: string): { subtotal: number; discount: number; tax: number } {
  let subtotal = 0;
  for (const line of cart) subtotal += line.unitCents * line.quantity;

  const discount = applyDiscounts(cart, tier);
  const tax = computeTax(subtotal - discount, cart);

  return { subtotal, discount, tax };
}

/** I/O: hold stock in the warehouse service. */
async function reserveInventory(cart: CartLine[]): Promise<number> {
  await sleep(60);
  return cart.length;
}

/** I/O: the payment gateway — the single biggest chunk of wall time. */
async function chargePayment(totalCents: number): Promise<string> {
  await sleep(90);
  return `ch_${totalCents.toString(36)}`;
}

/** CPU: serialize the response. */
export function renderReceipt(receipt: Receipt): string {
  let out = "";
  for (let i = 0; i < 100_000; i++) {
    out = JSON.stringify({ ...receipt, attempt: i });
  }
  return out;
}

export async function handleCheckout(customerId: string, cart: CartLine[]): Promise<Receipt> {
  validateCart(cart);

  const customer = await loadCustomer(customerId);

  const { subtotal, discount, tax } = priceCart(cart, customer.tier);
  const total = subtotal - discount + tax;

  await reserveInventory(cart);
  await chargePayment(total);

  const receipt: Receipt = {
    customerId: customer.id,
    lines: cart.length,
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    totalCents: total,
  };

  renderReceipt(receipt);
  return receipt;
}
