// What the person types into the page's number fields (the caps, a ticket's limit price), read as they meant it. A
// comma before exactly three digits groups thousands ($1,000); a comma before one or two digits at the end is a decimal
// comma (2,5 is 2.5, as much of the world writes it). Anything else unclear is not a number, so the server refuses it
// and nothing looser than the person meant is saved: "2,5" never becomes 25.

/** A typed figure as a number, or NaN when it is unclear. A $ or % sign and spaces are allowed. */
export function typedNumber(typed: string): number {
  const s = typed.replace(/[$%\s]/g, '');
  if (/^[1-9]\d{0,2}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''));   // thousands: 1,000 or 2,500.50
  if (/^\d+,\d{1,2}$/.test(s)) return Number(s.replace(',', '.'));                     // a decimal comma: 2,5 or 186,50
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  return NaN;
}

/** The figures a ticket was sent to Robinhood's check with, against the ones on the page now: an answer that comes back
 *  after the person changed them is not the check of the new figures. */
export interface Asked { id?: string; quantity: number; limit: number; market?: boolean; dollars?: number }
export const sameFigures = (asked: Asked, now: Asked): boolean => asked.id === now.id && asked.quantity === now.quantity && asked.limit === now.limit
  && !!asked.market === !!now.market && (asked.dollars ?? null) === (now.dollars ?? null);
