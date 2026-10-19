import type { Identity } from "./types";

const SCHEMA = [
  // order_id is no longer written or read (identity joins by checkout token only). It stays in
  // the table so new and existing databases have the same shape.
  `CREATE TABLE IF NOT EXISTS identities (
    shop TEXT NOT NULL,
    checkout_token TEXT NOT NULL,
    order_id TEXT,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (shop, checkout_token)
  )`,
  `CREATE INDEX IF NOT EXISTS identities_updated ON identities (updated_at)`,
  `CREATE TABLE IF NOT EXISTS orders (
    shop TEXT NOT NULL,
    order_id TEXT NOT NULL,
    checkout_token TEXT,
    currency TEXT,
    created_at INTEGER NOT NULL,
    test INTEGER,
    source_name TEXT,
    PRIMARY KEY (shop, order_id)
  )`,
  `CREATE INDEX IF NOT EXISTS orders_checkout ON orders (shop, checkout_token)`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    shop TEXT NOT NULL,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    target TEXT NOT NULL,
    -- Claim time while pending, delivery time once done. Cleanup ages rows out by it.
    delivered_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'done',
    claimed_at INTEGER,
    PRIMARY KEY (shop, kind, ref_id, target)
  )`,
];

/**
 * Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an existing table as it
 * is, so these are added with ALTER TABLE when missing. Existing deliveries rows were all written
 * after a successful send, so they default to state 'done'.
 */
const ADDED_COLUMNS: Record<string, [name: string, type: string][]> = {
  orders: [
    ["test", "INTEGER"],
    ["source_name", "TEXT"],
  ],
  deliveries: [
    ["state", "TEXT NOT NULL DEFAULT 'done'"],
    ["claimed_at", "INTEGER"],
  ],
};

/**
 * Adds the named columns a table doesn't have yet. Two isolates can race here, so "duplicate column"
 * from the loser is ignored. Exported for tests.
 */
export async function addMissingColumns(db: D1Database, table: string, columns: [name: string, type: string][]): Promise<void> {
  const { results } = await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>();
  const have = new Set(results.map((r) => r.name));
  for (const [name, type] of columns) {
    if (have.has(name)) continue;
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
  }
}

// Created on first use so a fresh deploy needs no migration step. Memoized per isolate.
const ready = new WeakMap<D1Database, Promise<void>>();

export function ensureSchema(db: D1Database): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = (async () => {
      await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
      for (const [table, columns] of Object.entries(ADDED_COLUMNS)) await addMissingColumns(db, table, columns);
    })();
    p.catch(() => ready.delete(db));
    ready.set(db, p);
  }
  return p;
}

/** A pending claim older than this is taken to be from a consumer that died mid-send. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

export interface StoredIdentity {
  identity: Identity;
}

export interface StoredOrder {
  orderId: string;
  checkoutToken: string | null;
  currency: string | null;
  /** null for rows written before the column existed. */
  test: boolean | null;
  sourceName: string | null;
}

export interface OrderFlags {
  test?: boolean;
  sourceName?: string;
}

export type DeliveryKind = "purchase" | "refund";

const DAY = 24 * 60 * 60 * 1000;

function parseIdentity(data: unknown): Identity | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as Identity;
  } catch {
    return null;
  }
}

export class Store {
  constructor(private readonly db: D1Database) {}

  async getIdentity(shop: string, checkoutToken: string): Promise<StoredIdentity | null> {
    const row = await this.db
      .prepare("SELECT data FROM identities WHERE shop = ? AND checkout_token = ?")
      .bind(shop, checkoutToken)
      .first<{ data: string }>();
    const identity = row && parseIdentity(row.data);
    return identity ? { identity } : null;
  }

  async putIdentity(shop: string, checkoutToken: string, identity: Identity): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO identities (shop, checkout_token, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (shop, checkout_token) DO UPDATE SET
           data = excluded.data,
           updated_at = excluded.updated_at`,
      )
      .bind(shop, checkoutToken, JSON.stringify(identity), Date.now())
      .run();
  }

  async putOrder(
    shop: string,
    orderId: string,
    checkoutToken: string | undefined,
    currency: string,
    createdAt: string,
    flags: OrderFlags = {},
  ): Promise<void> {
    const created = Date.parse(createdAt);
    const test = flags.test === undefined ? null : flags.test ? 1 : 0;
    await this.db
      .prepare(
        `INSERT INTO orders (shop, order_id, checkout_token, currency, created_at, test, source_name) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (shop, order_id) DO UPDATE SET
           checkout_token = COALESCE(excluded.checkout_token, orders.checkout_token),
           currency = COALESCE(excluded.currency, orders.currency),
           test = COALESCE(excluded.test, orders.test),
           source_name = COALESCE(excluded.source_name, orders.source_name)`,
      )
      .bind(shop, orderId, checkoutToken ?? null, currency || null, Number.isFinite(created) ? created : Date.now(), test, flags.sourceName ?? null)
      .run();
  }

  async getOrder(shop: string, orderId: string): Promise<StoredOrder | null> {
    const row = await this.db
      .prepare("SELECT order_id, checkout_token, currency, test, source_name FROM orders WHERE shop = ? AND order_id = ?")
      .bind(shop, orderId)
      .first<{ order_id: string; checkout_token: string | null; currency: string | null; test: number | null; source_name: string | null }>();
    if (!row) return null;
    return {
      orderId: row.order_id,
      checkoutToken: row.checkout_token,
      currency: row.currency,
      test: row.test === null ? null : row.test === 1,
      sourceName: row.source_name,
    };
  }

  /**
   * Claims one delivery before the send, so two consumers holding the same event (a webhook Shopify
   * sent twice, a retry racing the original) can't both send it. Returns the claim token to pass
   * to completeDelivery or releaseDelivery, or null when the event is done or another consumer
   * holds a claim younger than STALE_CLAIM_MS. An older pending claim is taken over: its consumer
   * died between claiming and finishing, or failed to release it. deliveryState tells the two
   * null cases apart.
   */
  async claimDelivery(shop: string, kind: DeliveryKind, refId: string, target: string, now = Date.now()): Promise<number | null> {
    const inserted = await this.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (shop, kind, ref_id, target, delivered_at, state, claimed_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(shop, kind, refId, target, now, now)
      .run();
    if (inserted.meta.changes > 0) return now;

    // One conditional UPDATE, so of two consumers taking over the same stale claim only one wins.
    const takenOver = await this.db
      .prepare(
        `UPDATE deliveries SET claimed_at = ?, delivered_at = ?
         WHERE shop = ? AND kind = ? AND ref_id = ? AND target = ?
           AND state = 'pending' AND (claimed_at IS NULL OR claimed_at < ?)`,
      )
      .bind(now, now, shop, kind, refId, target, now - STALE_CLAIM_MS)
      .run();
    return takenOver.meta.changes > 0 ? now : null;
  }

  /** The row's state, or null when there's none. */
  async deliveryState(shop: string, kind: DeliveryKind, refId: string, target: string): Promise<"done" | "pending" | null> {
    const row = await this.db
      .prepare("SELECT state FROM deliveries WHERE shop = ? AND kind = ? AND ref_id = ? AND target = ?")
      .bind(shop, kind, refId, target)
      .first<{ state: string }>();
    if (!row) return null;
    return row.state === "done" ? "done" : "pending";
  }

  async completeDelivery(shop: string, kind: DeliveryKind, refId: string, target: string, now = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE deliveries SET state = 'done', delivered_at = ?
         WHERE shop = ? AND kind = ? AND ref_id = ? AND target = ?`,
      )
      .bind(now, shop, kind, refId, target)
      .run();
  }

  /** Drops this consumer's pending claim, so a retry can claim again. Leaves a takeover alone. */
  async releaseDelivery(shop: string, kind: DeliveryKind, refId: string, target: string, claim: number): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM deliveries
         WHERE shop = ? AND kind = ? AND ref_id = ? AND target = ? AND state = 'pending' AND claimed_at = ?`,
      )
      .bind(shop, kind, refId, target, claim)
      .run();
  }

  /**
   * Identities with no orders row for their checkout token go after 7 days; everything else after
   * 400 days, long enough for late refunds.
   */
  async cleanup(now = Date.now()): Promise<void> {
    const week = now - 7 * DAY;
    const longAgo = now - 400 * DAY;
    await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM identities WHERE updated_at < ? AND NOT EXISTS (
             SELECT 1 FROM orders o WHERE o.shop = identities.shop AND o.checkout_token = identities.checkout_token
           )`,
        )
        .bind(week),
      this.db.prepare("DELETE FROM identities WHERE updated_at < ?").bind(longAgo),
      this.db.prepare("DELETE FROM orders WHERE created_at < ?").bind(longAgo),
      this.db.prepare("DELETE FROM deliveries WHERE delivered_at < ?").bind(longAgo),
    ]);
  }
}

export async function openStore(db: D1Database): Promise<Store> {
  await ensureSchema(db);
  return new Store(db);
}
