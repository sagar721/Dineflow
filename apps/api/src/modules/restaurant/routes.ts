// Restaurant profile, settings, tax configuration and onboarding completion.
// Design: docs/design/02-api-auth-tenancy.md §6.3; PRD FR-003 … FR-008.
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../lib/db.ts';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.ts';
import { authenticate, requirePermission, staffPrincipal } from '../../middleware/context.ts';
import type { Verifier } from '../../auth/jwt.ts';

export type RestaurantDeps = { db: Database; verify: Verifier; cookieSecure: boolean };

const optionalText = (max: number) => z.string().trim().max(max).nullish();

const profileBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    addressLine1: optionalText(120),
    addressLine2: optionalText(120),
    city: optionalText(80),
    region: optionalText(80),
    postalCode: optionalText(20),
    country: z.string().trim().length(2).toUpperCase().nullish(),
    phone: z.string().trim().max(30).regex(/^[+0-9 ()-]*$/, 'Use digits, spaces and + ( ) - only.').nullish(),
    email: z.union([z.string().trim().toLowerCase().email().max(254), z.literal(''), z.null()]).optional(),
    openingHoursText: optionalText(500),
    brandColor: z.union([z.string().trim().regex(/^#[0-9a-fA-F]{6}$/), z.null()]).optional(),
    acceptingOrders: z.boolean().optional(),
    // Owner-only; the database rejects it for anyone else, and so does the route.
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    version: z.number().int().min(1),
  })
  .strict();

const settingsBody = z
  .object({
    contactPolicy: z.enum(['off', 'optional', 'require_mobile', 'require_email', 'require_both']).optional(),
    orderPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{0,6}$/).optional(),
    pricesIncludeTax: z.boolean().optional(),
    serviceChargeBps: z.number().int().min(0).max(10_000).optional(),
    taxRegistrationNo: optionalText(40),
    billFooter: optionalText(500),
    roundingMode: z.enum(['none', 'nearest_50', 'nearest_1']).optional(),
    maxQtyPerLine: z.number().int().min(1).max(99).optional(),
    maxItemsPerOrder: z.number().int().min(1).max(200).optional(),
    managerDiscountCapBps: z.number().int().min(0).max(10_000).optional(),
    allowCustomerCancel: z.boolean().optional(),
    customerDataRetentionDays: z.number().int().min(1).max(3650).nullish(),
  })
  .strict();

const taxBody = z
  .object({
    name: z.string().trim().min(1).max(40),
    rateBps: z.number().int().min(0).max(10_000),
    sortOrder: z.number().int().min(0).max(100).default(0),
    active: z.boolean().default(true),
  })
  .strict();

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'VALIDATION_FAILED',
      'Please check the details you entered.',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export function restaurantRoutes(deps: RestaurantDeps): Router {
  const { db, verify, cookieSecure } = deps;
  const router = Router();
  router.use(authenticate({ db, verify, cookieSecure }));

  // ------------------------------------------------------------------ profile
  router.get('/', requirePermission('restaurant.read'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const data = await db.asStaff(principal, async (client) => {
        const restaurant = await client.query(
          `select id, slug, name, status, accepting_orders, currency, timezone, logo_path,
                  brand_color, address_line1, address_line2, city, region, postal_code,
                  country, phone, email, opening_hours_text, version, created_at
             from restaurants`);
        const settings = await client.query(
          `select contact_policy, order_prefix, prices_include_tax, service_charge_bps,
                  tax_registration_no, bill_footer, rounding_mode, max_qty_per_line,
                  max_items_per_order, manager_discount_cap_bps, allow_customer_cancel,
                  customer_data_retention_days, onboarding_completed_at
             from restaurant_settings`);
        const taxes = await client.query(
          `select id, name, rate_bps, sort_order, active from tax_components order by sort_order, name`);
        return { restaurant: restaurant.rows[0], settings: settings.rows[0], taxComponents: taxes.rows };
      });

      if (!data.restaurant) throw notFound();
      res.status(200).json(data);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/', requirePermission('restaurant.update'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(profileBody, req.body);

      // Currency and timezone are owner-only. The database enforces it too; this
      // check exists so the caller gets a clear 403 instead of a generic failure.
      if ((body.currency !== undefined || body.timezone !== undefined) && principal.role !== 'owner') {
        throw forbidden('Only an owner may change the currency or time zone.');
      }
      if (body.timezone !== undefined && !isKnownTimezone(body.timezone)) {
        throw badRequest('VALIDATION_FAILED', 'That time zone is not recognised.', [
          { field: 'timezone', message: 'Use an IANA name such as Asia/Kolkata.' },
        ]);
      }

      const updated = await db.asStaff(principal, async (client) => {
        const result = await client.query(
          `update restaurants set
             name = coalesce($1, name),
             address_line1 = coalesce($2, address_line1),
             address_line2 = coalesce($3, address_line2),
             city = coalesce($4, city),
             region = coalesce($5, region),
             postal_code = coalesce($6, postal_code),
             country = coalesce($7, country),
             phone = coalesce($8, phone),
             email = coalesce(nullif($9, ''), email),
             opening_hours_text = coalesce($10, opening_hours_text),
             brand_color = coalesce($11, brand_color),
             accepting_orders = coalesce($12, accepting_orders),
             currency = coalesce($13, currency),
             timezone = coalesce($14, timezone),
             version = version + 1
           where version = $15
           returning version`,
          [
            body.name ?? null, body.addressLine1 ?? null, body.addressLine2 ?? null,
            body.city ?? null, body.region ?? null, body.postalCode ?? null, body.country ?? null,
            body.phone ?? null, body.email ?? null, body.openingHoursText ?? null,
            body.brandColor ?? null, body.acceptingOrders ?? null,
            body.currency ?? null, body.timezone ?? null, body.version,
          ],
        );
        if (result.rowCount === 0) {
          // Either someone else saved first, or this is another tenant's row and RLS
          // hid it. Both are a 409 here: the caller should reload and try again.
          throw conflict('STALE_VERSION', 'Someone else changed these details. Reload and try again.');
        }
        await audit(client, principal, req, 'restaurant.profile.updated', {
          fields: Object.keys(body).filter((key) => key !== 'version'),
        });
        return result.rows[0];
      });

      res.status(200).json({ version: updated.version });
    } catch (error) {
      next(error);
    }
  });

  // ----------------------------------------------------------------- settings
  router.patch('/settings', requirePermission('restaurant.settings.update'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(settingsBody, req.body);

      await db.asStaff(principal, async (client) => {
        const result = await client.query(
          `update restaurant_settings set
             contact_policy = coalesce($1, contact_policy),
             order_prefix = coalesce($2, order_prefix),
             prices_include_tax = coalesce($3, prices_include_tax),
             service_charge_bps = coalesce($4, service_charge_bps),
             tax_registration_no = coalesce($5, tax_registration_no),
             bill_footer = coalesce($6, bill_footer),
             rounding_mode = coalesce($7, rounding_mode),
             max_qty_per_line = coalesce($8, max_qty_per_line),
             max_items_per_order = coalesce($9, max_items_per_order),
             manager_discount_cap_bps = coalesce($10, manager_discount_cap_bps),
             allow_customer_cancel = coalesce($11, allow_customer_cancel),
             customer_data_retention_days = coalesce($12, customer_data_retention_days),
             updated_by = $13`,
          [
            body.contactPolicy ?? null, body.orderPrefix ?? null, body.pricesIncludeTax ?? null,
            body.serviceChargeBps ?? null, body.taxRegistrationNo ?? null, body.billFooter ?? null,
            body.roundingMode ?? null, body.maxQtyPerLine ?? null, body.maxItemsPerOrder ?? null,
            body.managerDiscountCapBps ?? null, body.allowCustomerCancel ?? null,
            body.customerDataRetentionDays ?? null, principal.userId,
          ],
        );
        if (result.rowCount === 0) throw notFound();
        await audit(client, principal, req, 'restaurant.settings.updated', { fields: Object.keys(body) });
      });

      res.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  // ------------------------------------------------------------ tax components
  router.post('/tax-components', requirePermission('restaurant.tax.update'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const body = parse(taxBody, req.body);

      const created = await db.asStaff(principal, async (client) => {
        let result;
        try {
          result = await client.query<{ id: string }>(
            `insert into tax_components (restaurant_id, name, rate_bps, sort_order, active)
             values ($1, $2, $3, $4, $5) returning id`,
            [principal.restaurantId, body.name, body.rateBps, body.sortOrder, body.active]);
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw conflict('TAX_NAME_TAKEN', 'A tax with that name already exists.');
          }
          throw error;
        }
        await audit(client, principal, req, 'restaurant.tax.created',
          { name: body.name, rateBps: body.rateBps });
        return result.rows[0]!;
      });

      res.status(201).json({ id: created.id });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/tax-components/:id', requirePermission('restaurant.tax.update'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);
      const id = z.string().uuid().safeParse(req.params.id);
      if (!id.success) throw notFound();
      const body = parse(taxBody.partial(), req.body);

      await db.asStaff(principal, async (client) => {
        const result = await client.query(
          `update tax_components set
             name = coalesce($1, name),
             rate_bps = coalesce($2, rate_bps),
             sort_order = coalesce($3, sort_order),
             active = coalesce($4, active)
           where id = $5`,
          [body.name ?? null, body.rateBps ?? null, body.sortOrder ?? null, body.active ?? null, id.data]);
        if (result.rowCount === 0) throw notFound();
        await audit(client, principal, req, 'restaurant.tax.updated', { id: id.data });
      });

      res.status(200).json({ status: 'ok' });
    } catch (error) {
      next(error);
    }
  });

  // -------------------------------------------------------------- onboarding
  /**
   * Finishing onboarding is what takes a restaurant live (US-02). The checks are
   * the minimum a bill needs to be meaningful: who the restaurant is, and where.
   */
  router.post('/onboarding/complete', requirePermission('restaurant.settings.update'), async (req, res, next) => {
    try {
      const principal = staffPrincipal(req);

      const result = await db.asStaff(principal, async (client) => {
        const { rows } = await client.query<{
          status: string; name: string; address_line1: string | null; city: string | null;
          phone: string | null; email: string | null;
        }>(`select status, name, address_line1, city, phone, email from restaurants`);
        const restaurant = rows[0];
        if (!restaurant) throw notFound();

        const missing: string[] = [];
        if (!restaurant.address_line1) missing.push('addressLine1');
        if (!restaurant.city) missing.push('city');
        if (!restaurant.phone && !restaurant.email) missing.push('phone or email');
        if (missing.length) {
          throw badRequest('ONBOARDING_INCOMPLETE',
            'Add your address and a contact number before going live.',
            missing.map((field) => ({ field, message: 'Required before going live.' })));
        }

        if (restaurant.status === 'active') {
          // Already live: say so rather than pretending to act.
          return { status: 'active' as const, alreadyActive: true };
        }
        if (restaurant.status !== 'provisioning') {
          throw conflict('NOT_PROVISIONING', 'This restaurant cannot be activated.');
        }

        await client.query(`update restaurant_settings set onboarding_completed_at = now(), updated_by = $1`,
          [principal.userId]);
        // The database permits exactly this transition for an owner and nothing else.
        await client.query(`update restaurants set status = 'active', version = version + 1`);
        await audit(client, principal, req, 'restaurant.onboarding.completed', {});
        return { status: 'active' as const, alreadyActive: false };
      });

      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

async function audit(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  principal: { restaurantId: string; userId: string; role: string },
  req: { clientIp: string; requestId: string; headers: Record<string, unknown> },
  action: string,
  summary: Record<string, unknown>,
): Promise<void> {
  // The restaurant id is passed twice rather than reused as $1: Postgres infers one
  // type per parameter, and using the same one as uuid and as text is an error.
  await client.query(
    `insert into audit_log (restaurant_id, actor_user_id, actor_role, action, entity_type, entity_id, summary, ip, request_id)
     values ($1::uuid, $2, $3, $4, 'restaurant', $5::text, $6, $7, $8)`,
    [principal.restaurantId, principal.userId, principal.role, action, principal.restaurantId,
     JSON.stringify(summary), req.clientIp, req.requestId],
  );
}

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
