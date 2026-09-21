import { html2Plain, ofx2json } from './ofx2json';

describe('html2Plain', () => {
  test('regular text works', async () => {
    expect(html2Plain('Hello, world!')).toBe('Hello, world!');
    expect(html2Plain('Hello, <b>world</b>!')).toBe('Hello, <b>world</b>!');
  });

  test('brackets are unescaped', async () => {
    expect(html2Plain('Hello, &lt;world&gt;!')).toBe('Hello, <world>!');
  });
  test('apostrophes are unescaped', async () => {
    expect(html2Plain('Hello, &#39;world&#39;!')).toBe("Hello, 'world'!");
  });
  test('quotes are unescaped', async () => {
    expect(html2Plain('Hello, &quot;world&quot;!')).toBe('Hello, "world"!');
  });
  test('ampersands are unescaped', async () => {
    expect(html2Plain('Hello, &amp;world&amp;!')).toBe('Hello, &world&!');
    expect(html2Plain('Hello, &#038;world&#038;!')).toBe('Hello, &world&!');
  });
  test('no double unescaping with other entities', async () => {
    expect(html2Plain('Hello, &amp;#038;world&amp;#038;!')).toBe(
      'Hello, &#038;world&#038;!',
    );
    expect(html2Plain('Hello, &#038;amp;world&#038;amp;!')).toBe(
      'Hello, &amp;world&amp;!',
    );
    expect(html2Plain('Hello, &amp;quot;world&amp;quot;!')).toBe(
      'Hello, &quot;world&quot;!',
    );
  });
});

describe('ofx2json investment statements', () => {
  const inv = (banktran: string) => `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><INVTRANLIST>${banktran}</INVTRANLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>`;
  const trn = (id: string) =>
    `<INVBANKTRAN><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260105<TRNAMT>10.00<FITID>${id}<NAME>Dividend</STMTTRN><SUBACCTFUND>CASH</INVBANKTRAN>`;

  test('a single INVBANKTRAN parses (was: flatMap is not a function)', async () => {
    const result = await ofx2json(inv(trn('a')));
    expect(result.transactions.map(t => t.fitId)).toEqual(['a']);
  });

  test('several INVBANKTRAN parse', async () => {
    const result = await ofx2json(inv(trn('a') + trn('b')));
    expect(result.transactions.map(t => t.fitId)).toEqual(['a', 'b']);
  });
});
