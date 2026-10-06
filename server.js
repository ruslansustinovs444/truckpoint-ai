import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import nodemailer from "nodemailer";
import * as cheerio from "cheerio";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 10000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SITE_BASE = "https://www.truck-point.net";

const CATALOG_PAGES = {
  truck: `${SITE_BASE}/trucks`,
  trailer: `${SITE_BASE}/trailers`
};

let catalog = [];
let syncStatus = {
  running: false,
  last_started_at: null,
  last_finished_at: null,
  last_error: null
};


// ============================================================
// HELPERS
// ============================================================

function absoluteUrl(url) {
  if (!url) return null;

  try {
    return new URL(url, SITE_BASE).href;
  } catch {
    return null;
  }
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePrice(value) {
  if (!value) return null;

  const match = String(value).replace(/\s/g, "").match(/€?([\d,.]+)/);

  if (!match) return null;

  const number = match[1]
    .replace(/,/g, "")
    .replace(/\.(?=\d{3})/g, "");

  const parsed = Number(number);

  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumber(value) {
  if (!value) return null;

  const match = String(value).replace(/\s/g, "").match(/[\d,.]+/);

  if (!match) return null;

  const normalized = match[0]
    .replace(/,(?=\d{3})/g, "")
    .replace(",", ".");

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

function parseSpecs(description) {
  const result = {};

  const lines = String(description || "")
    .split(/\n/)
    .map(line => cleanText(line))
    .filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf(":");

    if (separator === -1) continue;

    const key = cleanText(line.slice(0, separator));
    const value = cleanText(line.slice(separator + 1));

    if (key && value) {
      result[key] = value;
    }
  }

  return result;
}

function normalizeSpecs(raw) {
  const result = {};

  const makeModel =
    raw["Make/Model"] ||
    raw["Make / Model"] ||
    raw["Model"] ||
    null;

  const year =
    parseNumber(raw["Year"]) ||
    null;

  const mileage =
    parseNumber(raw["Mileage"]) ||
    null;

  const engineText =
    raw["Engine"] ||
    null;

  const engineLiters =
    engineText ? parseNumber(engineText) : null;

  let powerHp = null;

  if (engineText) {
    const hpMatch = engineText.match(/(\d+)\s*HP/i);

    if (hpMatch) {
      powerHp = Number(hpMatch[1]);
    }
  }

  const quantity =
    parseNumber(raw["Quantity"]) ||
    null;

  result.make_model = makeModel;
  result.year = year;
  result.mileage_km = mileage;
  result.engine = engineText;
  result.engine_l = engineLiters;
  result.power_hp = powerHp;
  result.emission = raw["Emission"] || null;
  result.axle_configuration =
    raw["Axle Configuration"] ||
    raw["Axle configuration"] ||
    null;
  result.cab = raw["Cab"] || null;
  result.park_cool = raw["Park cool"] || null;
  result.retarder = raw["Retarder"] || null;
  result.location = raw["Location"] || null;
  result.quantity = quantity;

  return result;
}


// ============================================================
// FETCH
// ============================================================

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; TruckPointAI/1.0; catalog importer)"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return await response.text();
}


// ============================================================
// PARSE LIST PAGE
// ============================================================

function parseListPage(html, type, sourcePage) {
  const $ = cheerio.load(html);

  const items = [];

  $(".t404__link").each((index, element) => {
    const link = $(element);

    const href = link.attr("href");

    if (!href) return;

    const url = absoluteUrl(href);

    const title = cleanText(
      link.find(".t404__title").text()
    );

    const priceText = cleanText(
      link.find(".t404__descr").text()
    );

    const imageElement = link.find(".t404__img").first();

    const image =
      imageElement.attr("data-original") ||
      imageElement.attr("src") ||
      null;

    items.push({
      type,
      title,
      price_text: priceText,
      price_eur: parsePrice(priceText),
      url,
      image: absoluteUrl(image),
      source_page: sourcePage,
      details_loaded: false
    });
  });

  return items;
}


// ============================================================
// PARSE DETAIL PAGE
// ============================================================

function parseDetailPage(html, item) {
  const $ = cheerio.load(html);

  const title =
    cleanText(
      $(".t764__title.js-product-name").first().text()
    ) ||
    cleanText($("title").first().text()) ||
    item.title;

  const description =
  descriptionElement
    .clone()
    .find("br")
    .replaceWith("\n")
    .end()
    .text();

const rawSpecs = parseSpecs(description);
  const specs = normalizeSpecs(rawSpecs);

  const images = [];

  $(".t-slds__bgimg").each((index, element) => {
    const imageElement = $(element);

    const image =
      imageElement.attr("data-original") ||
      imageElement.attr("data-img-zoom-url");

    if (image) {
      const absolute = absoluteUrl(image);

      if (absolute && !images.includes(absolute)) {
        images.push(absolute);
      }
    }
  });

  const ogImage =
    $("meta[property='og:image']").attr("content");

  if (ogImage) {
    const absolute = absoluteUrl(ogImage);

    if (absolute && !images.includes(absolute)) {
      images.unshift(absolute);
    }
  }

  const metaDescription =
    $("meta[name='description']").attr("content") || "";

  const priceFromPage =
    parsePrice(metaDescription) ||
    item.price_eur;

  return {
    ...item,

    title,
    price_eur: priceFromPage,

    ...specs,

    images,

    description_raw: cleanText(description),

    details_loaded: true
  };
}


// ============================================================
// IMPORT ONE ITEM
// ============================================================

async function enrichItem(item) {
  try {
    const html = await fetchHtml(item.url);

    return parseDetailPage(html, item);
  } catch (error) {
    console.error(
      `Catalog detail error: ${item.url}`,
      error.message
    );

    // ВАЖНО:
    // Если карточка не загрузилась, не удаляем ее.
    // Оставляем только проверенные данные со страницы списка.
    return {
      ...item,
      details_loaded: false,
      details_error: error.message
    };
  }
}


// ============================================================
// CONCURRENCY
// ============================================================

async function enrichItems(items, concurrency = 5) {
  const result = new Array(items.length);

  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;

      if (index >= items.length) {
        return;
      }

      result[index] = await enrichItem(items[index]);

      console.log(
        `Catalog: ${index + 1}/${items.length} processed`
      );
    }
  }

  const workers = [];

  for (
    let i = 0;
    i < Math.min(concurrency, items.length);
    i++
  ) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return result;
}


// ============================================================
// FULL SYNC
// ============================================================

async function syncCatalog() {
  if (syncStatus.running) {
    console.log("Catalog sync already running");
    return;
  }

  syncStatus.running = true;
  syncStatus.last_started_at = new Date().toISOString();
  syncStatus.last_error = null;

  console.log("====================================");
  console.log("Truck Point catalog sync started");
  console.log("====================================");

  try {
    const allItems = [];

    // ----------------------------
    // TRUCKS
    // ----------------------------

    const trucksHtml =
      await fetchHtml(CATALOG_PAGES.truck);

    const trucks = parseListPage(
      trucksHtml,
      "truck",
      CATALOG_PAGES.truck
    );

    console.log(
      `Found ${trucks.length} trucks`
    );

    allItems.push(...trucks);


    // ----------------------------
    // TRAILERS
    // ----------------------------

    const trailersHtml =
      await fetchHtml(CATALOG_PAGES.trailer);

    const trailers = parseListPage(
      trailersHtml,
      "trailer",
      CATALOG_PAGES.trailer
    );

    console.log(
      `Found ${trailers.length} trailers`
    );

    allItems.push(...trailers);


    // ----------------------------
    // DETAILS
    // ----------------------------

    const enriched =
      await enrichItems(allItems, 5);

    const syncedAt =
      new Date().toISOString();

    catalog = enriched.map(item => ({
      ...item,
      last_synced_at: syncedAt
    }));

    syncStatus.last_finished_at = syncedAt;

    console.log("====================================");
    console.log(
      `Catalog sync finished: ${catalog.length} items`
    );
    console.log("====================================");

  } catch (error) {
    console.error(
      "Catalog sync failed:",
      error
    );

    syncStatus.last_error =
      error.message;

  } finally {
    syncStatus.running = false;
  }
}


// ============================================================
// CATALOG SEARCH
// ============================================================

function searchCatalog(message, conversation = []) {
  const text = String(message || "").toLowerCase();

  let results = [...catalog];

  // --------------------------------------------------
  // 1. Если пользователь ссылается на конкретный
  // автомобиль из предыдущего сообщения
  // --------------------------------------------------

  const previousAssistantText = conversation
    .filter(message => message?.role === "assistant")
    .map(message => String(message.content || ""))
    .join("\n")
    .toLowerCase();

  // Ищем упоминания автомобилей из каталога
  // в текущем сообщении и предыдущем ответе AI.
  const candidateItems = catalog.filter(item => {
    const title = String(item.title || "").toLowerCase();
    const url = String(item.url || "").toLowerCase();

    const price =
      item.price_eur !== null &&
      item.price_eur !== undefined
        ? String(item.price_eur)
        : "";

    const titleWords = title
      .split(/\s+/)
      .filter(word => word.length >= 3);

    const titleMatch =
      title &&
      titleWords.length > 0 &&
      titleWords.filter(word => text.includes(word)).length >=
        Math.min(2, titleWords.length);

    const urlMatch =
      url && text.includes(url);

    const priceMatch =
      price &&
      (
        text.includes(price) ||
        text.includes(`€${price}`) ||
        text.includes(`€ ${price}`)
      );

    return titleMatch || urlMatch || priceMatch;
  });

  // Если найден конкретный автомобиль,
  // возвращаем именно его.
  if (candidateItems.length > 0) {
    return candidateItems;
  }

  // --------------------------------------------------
  // 2. Если пользователь говорит "this truck",
  // "этот грузовик", "этот автомобиль" и т.п.,
  // ищем последний автомобиль, который AI показывал
  // в предыдущем сообщении.
  // --------------------------------------------------

  const refersToPreviousVehicle =
    /this truck|this vehicle|this tractor|this one|that truck|that vehicle|that one|этот тягач|этот грузовик|этот автомобиль|этот|эту машину|этой машине|данный автомобиль|тот тягач|тот грузовик/i.test(
      text
    );

  if (
    refersToPreviousVehicle &&
    previousAssistantText
  ) {
    const previousMatches = catalog.filter(item => {
      const title =
        String(item.title || "").toLowerCase();

      const url =
        String(item.url || "").toLowerCase();

      return (
        previousAssistantText.includes(title) ||
        previousAssistantText.includes(url)
      );
    });

    if (previousMatches.length > 0) {
      // Берём последний совпавший автомобиль,
      // чтобы не вернуть весь список.
      return [
        previousMatches[previousMatches.length - 1]
      ];
    }
  }

  // --------------------------------------------------
  // 3. TYPE
  // --------------------------------------------------

  const asksTrailer =
    /trailer|trailers|semi-trailer|semi trailer|прицеп|полуприцеп|прицепы/i.test(
      text
    );

  const asksTruck =
    /truck|trucks|tractor|tractor unit|тягач|тягачи|грузовик/i.test(
      text
    );

  if (asksTrailer && !asksTruck) {
    results = results.filter(
      item => item.type === "trailer"
    );
  }

  if (asksTruck && !asksTrailer) {
    results = results.filter(
      item => item.type === "truck"
    );
  }

  // --------------------------------------------------
  // 4. BUDGET
  // --------------------------------------------------

  let maxPrice = null;

  const patterns = [
    /(?:under|below|less than|max(?:imum)?|up to)\s*€?\s*([\d\s,.]+)\s*(?:eur|€)?/i,

    /(?:до|не дороже|максимум|бюджет)\s*€?\s*([\d\s,.]+)\s*(?:евро|eur|€)?/i,

    /€\s*([\d\s,.]+)\s*(?:eur)?/i,

    /([\d\s,.]+)\s*(?:eur|€|евро)/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (match) {
      maxPrice = parseNumber(match[1]);
      break;
    }
  }

  if (maxPrice !== null) {
    results = results.filter(
      item =>
        item.price_eur !== null &&
        item.price_eur <= maxPrice
    );
  }

  // --------------------------------------------------
  // 5. BRAND
  // --------------------------------------------------

  const brands = [
    "daf",
    "volvo",
    "scania",
    "mercedes",
    "mb",
    "man",
    "renault",
    "ford",
    "iveco",
    "schmitz",
    "krone",
    "kogel",
    "wielton"
  ];

  const detectedBrands =
    brands.filter(brand =>
      text.includes(brand)
    );

  if (detectedBrands.length) {
    results = results.filter(item => {
      const haystack = [
        item.title,
        item.make_model,
        item.description_raw
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return detectedBrands.some(
        brand => haystack.includes(brand)
      );
    });
  }

  // --------------------------------------------------
  // 6. YEAR
  // --------------------------------------------------

  const yearMatch =
    text.match(/\b(20\d{2})\b/);

  if (yearMatch) {
    const year = Number(yearMatch[1]);

    results = results.filter(
      item => item.year === year
    );
  }

  return results;
}


// ============================================================
// AI CATALOG CONTEXT
// ============================================================

function buildCatalogContext(items) {
  if (!items.length) {
    return "No matching catalog items found.";
  }

  return items
    .map((item, index) => {
      return `
ITEM ${index + 1}
Type: ${item.type}
Title: ${item.title}
Price EUR: ${item.price_eur ?? "not specified"}
Year: ${item.year ?? "not specified"}
Mileage km: ${item.mileage_km ?? "not specified"}
Engine: ${item.engine ?? "not specified"}
Power HP: ${item.power_hp ?? "not specified"}
Emission: ${item.emission ?? "not specified"}
Axle configuration: ${item.axle_configuration ?? "not specified"}
Cab: ${item.cab ?? "not specified"}
Park cool: ${item.park_cool ?? "not specified"}
Retarder: ${item.retarder ?? "not specified"}
Location: ${item.location ?? "not specified"}
Quantity: ${item.quantity ?? "not specified"}
Listed URL: ${item.url}
Details loaded: ${item.details_loaded ? "yes" : "no"}
`;
    })
    .join("\n");
}


// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(catalogContext) {
  return `
You are the Truck Point AI Consultant.

Truck Point sells commercial trucks, tractor units, trailers and semi-trailers.

Your job:
1. Help customers choose equipment.
2. Answer technical questions using only verified catalog information.
3. Help customers compare vehicles.
4. Identify suitable listings from the catalog.
5. Move interested customers toward contacting a manager.
6. Ask useful qualification questions when appropriate.

LANGUAGES:
The customer may communicate in Russian, English, German, Polish, Latvian or another language.
Answer in the language used by the customer.

VERY IMPORTANT CATALOG RULES:

The catalog below is the source of truth.

NEVER invent:
- price
- mileage
- year
- engine
- horsepower
- emission class
- axle configuration
- equipment
- availability
- quantity
- delivery date
- inspection status
- discount
- financing conditions

If a field says "not specified", say that it is not specified.

If a listing exists in the catalog, you may say:
"This vehicle is listed on the Truck Point website."

Do NOT claim that a vehicle is definitely physically available right now unless this is explicitly confirmed.

If the customer asks about something that is not in the catalog:
say that the information is not confirmed and offer to connect them with a manager.

When recommending vehicles:
- include the listing URL
- mention the price when available
- explain briefly why it matches the customer's request
- do not overwhelm the customer with every specification unless useful

When the customer asks for ALL vehicles matching a condition:
return ALL matching catalog items, not just one.

If there are no matches:
say that there are currently no matching listings in the imported catalog.

SALES QUALIFICATION:

When appropriate, determine:
- equipment type
- brand/model
- year
- mileage
- engine
- transmission
- axle configuration
- budget
- country/market
- intended use
- purchase timeframe

Do not interrogate the customer with all questions at once.
Ask only the next most useful question.

If the customer is clearly interested in buying, encourage them to leave:
- name
- phone
- email

The backend can send the lead to the sales team.

CURRENT CATALOG:

${catalogContext}
`;
}


// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  const trucks =
    catalog.filter(
      item => item.type === "truck"
    ).length;

  const trailers =
    catalog.filter(
      item => item.type === "trailer"
    ).length;

  res.json({
    ok: true,
    catalog_count: catalog.length,
    trucks,
    trailers,
    sync: syncStatus
  });
});


// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Truck Point AI Consultant",
    catalog_count: catalog.length
  });
});


// ============================================================
// CHAT
// ============================================================

app.post("/api/chat", async (req, res) => {
  try {
    const messages =
      Array.isArray(req.body.messages)
        ? req.body.messages
        : [];

    const latestUserMessage =
      [...messages]
        .reverse()
        .find(
          message =>
            message &&
            message.role === "user"
        );

    const userText =
      latestUserMessage?.content || "";

    const matchingCatalog =
  searchCatalog(userText, messages);

    const catalogContext =
      buildCatalogContext(
        matchingCatalog
      );

    const systemPrompt =
      buildSystemPrompt(
        catalogContext
      );

    const aiMessages = [
      {
        role: "system",
        content: systemPrompt
      },

      {
        role: "developer",
        content: `
The deterministic catalog search found
${matchingCatalog.length} matching listing(s)
for the latest customer message.

Use those listings when relevant.

Do not replace exact catalog results with generic advice.
`
      },

      ...messages.slice(-20)
    ];

    const completion =
  await openai.chat.completions.create({
    model:
      process.env.OPENAI_MODEL ||
      "gpt-5-mini",

    messages: aiMessages
  });

    const answer =
      completion.choices?.[0]?.message?.content ||
      "Sorry, I could not generate an answer.";

    res.json({
      reply: answer,
      catalog_matches:
        matchingCatalog.length
    });

  } catch (error) {
    console.error(
      "CHAT ERROR:",
      error
    );

    res.status(500).json({
      error: "AI request failed",
      details: error.message
    });
  }
});


// ============================================================
// LEAD EMAIL
// ============================================================

app.post("/api/lead", async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      language,
      equipment,
      brand,
      model,
      budget,
      timeframe,
      use_case,
      question,
      conversation
    } = req.body;

    const smtpUser =
      process.env.SMTP_USER;

    const smtpPass =
      process.env.SMTP_PASS;

    const leadToEmail =
      process.env.LEAD_TO_EMAIL;

    if (
      !smtpUser ||
      !smtpPass ||
      !leadToEmail
    ) {
      return res.status(500).json({
        error:
          "SMTP configuration is incomplete"
      });
    }

    const transporter =
      nodemailer.createTransport({
        host:
          process.env.SMTP_HOST ||
          "smtp.mail.yahoo.com",

        port:
          Number(
            process.env.SMTP_PORT || 465
          ),

        secure:
          String(
            process.env.SMTP_SECURE
          ) === "true",

        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });

    const subject =
      `Truck Point AI Lead${
        name ? ` — ${name}` : ""
      }`;

    const text = `
New Truck Point AI lead

Name: ${name || ""}
Phone: ${phone || ""}
Email: ${email || ""}
Language: ${language || ""}

Equipment: ${equipment || ""}
Brand: ${brand || ""}
Model: ${model || ""}
Budget: ${budget || ""}
Purchase timeframe: ${timeframe || ""}
Use case: ${use_case || ""}

Customer question:
${question || ""}

Conversation:
${conversation || ""}
`;

    await transporter.sendMail({
      from: smtpUser,
      to: leadToEmail,
      replyTo: email || undefined,
      subject,
      text
    });

    res.json({
      ok: true
    });

  } catch (error) {
    console.error(
      "LEAD ERROR:",
      error
    );

    res.status(500).json({
      error: "Lead email failed",
      details: error.message
    });
  }
});


// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
  console.log(
    `Truck Point AI running on port ${PORT}`
  );

  // Запускаем импорт после старта сервера.
  syncCatalog();

  // Обновляем каталог каждые 30 минут.
  setInterval(
    syncCatalog,
    30 * 60 * 1000
  );
});
