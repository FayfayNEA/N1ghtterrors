require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BASE = (process.env.BASE_URL || "https://n1ghtterrors.vercel.app").replace(
  /\/$/,
  ""
);

function img(p) {
  return `${BASE}${p.startsWith("/") ? "" : "/"}${p}`.replace(/ /g, "%20");
}

// ── All 20 inventory rows: short title (≤30 chars) + image_url ──────────
const CATALOG = [
  { id: 1,  title: "White Collared Shirt",      image_url: img("/images/shirt1.png") },
  { id: 2,  title: "Rorschach L Tee",           image_url: img("/images/Black3.jpg") },
  { id: 3,  title: "Virgin Mary Tee",           image_url: img("/images/nary1.jpg") },
  { id: 4,  title: "Pig Back L Tee",            image_url: img("/images/inside4.jpg") },
  { id: 5,  title: "Logo Tee - Youth L",        image_url: img("/images/bbyt1.jpg") },
  { id: 6,  title: "Logo Tee - Adult L",        image_url: img("/images/bbyt1.jpg") },
  { id: 7,  title: "Minimalist Collared XL",    image_url: img("/images/graycolared1.jpg") },
  { id: 8,  title: "Rorschach XL Tee",          image_url: img("/images/blackxl3.jpg") },
  { id: 9,  title: "Lace Royalty Top",          image_url: img("/images/lace5.jpg") },
  { id: 10, title: "Light Logo Tee Youth L",    image_url: img("/images/light3.jpg") },
  { id: 11, title: "Pig Front L Tee",           image_url: img("/images/pig3.jpg") },
  { id: 12, title: "Red Stripe XL Shirt",       image_url: img("/images/red1.jpg") },
  { id: 13, title: "Gray Western XL Shirt",     image_url: img("/images/gray1.jpg") },
  { id: 14, title: "2nd Gen Pig L Tee",         image_url: img("/images/gen1.jpg") },
  { id: 15, title: "1GEN Purple S",             image_url: img("/images/purplegen1.jpg") },
  { id: 16, title: "1GEN White S",              image_url: img("/images/whitegen.jpg") },
  { id: 17, title: "1GEN BLACK XS",             image_url: img("/images/blackgenback.jpg") },
  { id: 18, title: "1GEN BLACK S",              image_url: img("/images/blackgenback.jpg") },
  { id: 19, title: "1GEN BLACK M",              image_url: img("/images/blackgenback.jpg") },
  { id: 20, title: "1GEN BLACK Cropped L",      image_url: img("/images/blackgenback.jpg") },
];

async function main() {
  // ── 1. Show current state ─────────────────────────────────────────────
  const { data: before, error: fetchErr } = await supabase
    .from("inventory")
    .select("id, title, price_cents, image_url")
    .order("id");

  if (fetchErr) { console.error("Fetch error:", fetchErr.message); process.exit(1); }

  console.log("\n--- BEFORE ---");
  for (const r of before) {
    console.log(
      `  [${r.id}] "${r.title}" (${(r.title || "").length} chars)  img=${r.image_url || "(none)"}`
    );
  }

  // ── 2. Update each row with short title + image_url ───────────────────
  let updated = 0;
  for (const item of CATALOG) {
    const { error } = await supabase
      .from("inventory")
      .update({ title: item.title, image_url: item.image_url })
      .eq("id", item.id);

    if (error) {
      console.error(`  FAILED id=${item.id}: ${error.message}`);
    } else {
      updated++;
    }
  }
  console.log(`\nUpdated ${updated} / ${CATALOG.length} rows.`);

  // ── 3. Verify ─────────────────────────────────────────────────────────
  const { data: after } = await supabase
    .from("inventory")
    .select("id, title, price_cents, image_url, quantity")
    .order("id");

  console.log("\n--- AFTER ---");
  for (const r of after) {
    const price = `$${(r.price_cents / 100).toFixed(2)}`;
    console.log(
      `  [${r.id}] "${r.title}" (${r.title.length} chars)  ${price}  qty=${r.quantity}  img=${r.image_url}`
    );
  }

  const tooLong = after.filter((r) => r.title.length > 30);
  if (tooLong.length) {
    console.warn(`\nWARNING: ${tooLong.length} titles still > 30 chars:`);
    tooLong.forEach((r) => console.warn(`  [${r.id}] "${r.title}" (${r.title.length})`));
  } else {
    console.log("\nAll titles are ≤ 30 characters for Stripe.");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
