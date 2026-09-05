/** Country name (as Jolpica returns it) -> ISO-2 code, for flag rendering.
 *  Covers the full 2002-2026 Ergast vocabulary, not just the names seen in
 *  the current calendar — Jolpica uses demonyms/short forms a naive map
 *  misses (UAE, UK, USA), plus historic-calendar countries.
 */
export const COUNTRY_TO_ISO2: Record<string, string> = {
  Australia: 'AU',
  Austria: 'AT',
  Azerbaijan: 'AZ',
  Bahrain: 'BH',
  Belgium: 'BE',
  Brazil: 'BR',
  Canada: 'CA',
  China: 'CN',
  France: 'FR',
  Germany: 'DE',
  Hungary: 'HU',
  India: 'IN',
  Italy: 'IT',
  Japan: 'JP',
  Korea: 'KR',
  Malaysia: 'MY',
  Mexico: 'MX',
  Monaco: 'MC',
  Morocco: 'MA',
  Netherlands: 'NL',
  Portugal: 'PT',
  Qatar: 'QA',
  Russia: 'RU',
  'Saudi Arabia': 'SA',
  Singapore: 'SG',
  'South Africa': 'ZA',
  Spain: 'ES',
  Sweden: 'SE',
  Switzerland: 'CH',
  Turkey: 'TR',
  UAE: 'AE',
  UK: 'GB',
  USA: 'US',
};

function iso2ToFlagEmoji(iso2: string): string {
  const codePoints = iso2
    .toUpperCase()
    .split('')
    .map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

export function flagEmoji(country: string | null | undefined): string | null {
  if (!country) return null;
  const iso2 = COUNTRY_TO_ISO2[country];
  return iso2 ? iso2ToFlagEmoji(iso2) : null;
}

export function iso2Of(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_TO_ISO2[country] ?? null;
}
