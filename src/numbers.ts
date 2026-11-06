// Signed figures as the desk writes them: a value that rounds to zero is written as zero, never with a minus sign on
// nothing ("-0.0%" told the person a call lost ground when it had not). The dashboard's page writes its own the same way
// (src/terminal/ui/fmt.ts).

/** `v` to `digits` decimals with its sign: "+1.2", "-0.4", and "0.0" for anything that rounds to zero. */
export function signed(v: number, digits: number): string {
  const text = Math.abs(v).toFixed(digits);
  return Number(text) === 0 ? text : `${v > 0 ? '+' : '-'}${text}`;
}

/** A fraction as a signed percent: 0.0123 as "+1.2%" (one decimal), -0.00024 as "0.0%". */
export const signedPct = (fraction: number, digits = 1): string => `${signed(fraction * 100, digits)}%`;

/** A stored signed percent read back, with a zero's sign dropped: "-0.0%" as "0.0%" (calls scored before this was fixed). */
export const unsignZero = (text: string): string => text.replace(/^[+\-−](0(?:\.0+)?%)$/, '$1');
