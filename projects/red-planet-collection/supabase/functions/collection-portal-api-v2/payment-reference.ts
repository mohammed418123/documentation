/**
 * Keep Odoo's user-visible receipt fields equal to the handwritten receipt
 * number. Technical idempotency identifiers belong in the portal database.
 */
export function visiblePaymentReference(reference: string) {
  return {
    payment_reference: reference,
    memo: reference,
  };
}
