const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (Mac) Chrome/124', locale: 'en-US' });
  const page = await ctx.newPage();

  // Check if esim.holafly.com has an Indonesia page
  console.log('--- Testing esim.holafly.com/esim-indonesia/ ---');
  const r = await page.goto('https://esim.holafly.com/esim-indonesia/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(e => null);
  const url = page.url();
  const title = await page.title();
  const body = await page.evaluate(() => (document.body.innerText || '').substring(0, 300));
  console.log('URL:', url, '| Title:', title);
  console.log('Body:', body.substring(0, 200));

  // Also check holafly.com main site for Indonesia
  console.log('\n--- Testing holafly.com search for Indonesia ---');
  await page.goto('https://www.holafly.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(3000);
  const searchInput = await page.$('input[placeholder*="travel"], input[placeholder*="destination"], input#searchInput');
  if (searchInput) {
    await searchInput.fill('Indonesia');
    await page.waitForTimeout(2000);
    const suggestions = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[class*="suggestion"], [class*="result"], [class*="dropdown"] li, [class*="autocomplete"] li')];
      return items.slice(0, 5).map(el => el.textContent.trim());
    });
    console.log('Search suggestions:', suggestions);
  } else {
    console.log('No search input found');
  }

  await b.close();
})().catch(e => console.error(e.message));
