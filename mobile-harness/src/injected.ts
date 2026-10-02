// JavaScript run INSIDE the store page (the user's own WebView). Each snippet
// is the body of an async function; its return value is posted back.
//
// Hard rules (harness spec):
//   - _up_click_id is only READ (presence + first 6 chars). It is never
//     generated, copied or written; no UpPromote endpoint is called.
//   - The `cart` cookie is only ever set to THIS attempt's UCP cart, then
//     restored to the previous value (or removed).

const s = (v: string) => JSON.stringify(v)

export const JS = {
  /** Current value of the (non-HttpOnly) `cart` cookie, or null. */
  readCartCookie: `
    const m = document.cookie.match(/(?:^|; )cart=([^;]*)/);
    return m ? m[1] : null;`,

  /** Point the browser's current cart at the UCP cart (Mode C step 3). */
  setCartCookie: (token: string, key: string) => `
    document.cookie = 'cart=' + ${s(token)} + '%3Fkey%3D' + ${s(key)} + '; path=/; SameSite=Lax';
    return /(?:^|; )cart=/.test(document.cookie);`,

  /** Restore the previous cart cookie, or delete ours (Mode C step 6). */
  restoreCartCookie: (prev: string | null) =>
    prev
      ? `document.cookie = 'cart=' + ${s(prev)} + '; path=/; SameSite=Lax';
         const m = document.cookie.match(/(?:^|; )cart=([^;]*)/);
         return m ? m[1] === ${s(prev)} : false;`
      : `document.cookie = 'cart=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
         return !/(?:^|; )cart=/.test(document.cookie);`,

  /** Read-only view of /cart.js: token + whether _up_click_id is present. */
  cartInfo: `
    const r = await fetch('/cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('/cart.js HTTP ' + r.status);
    const j = await r.json();
    const up = (j.attributes || {})._up_click_id;
    return { token: j.token || null, hasUp: !!up, upHead: up ? String(up).slice(0, 6) : null, items: j.item_count };`,

  /** Mode B step 4: add the variant through the storefront's own cart API. */
  addToCart: (numericVariantId: string, qty: number) => `
    const r = await fetch('/cart/add.js', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items: [{ id: Number(${s(numericVariantId)}), quantity: ${qty} }] }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error('/cart/add.js HTTP ' + r.status + ' ' + text.slice(0, 160));
    return { ok: true };`,
}
