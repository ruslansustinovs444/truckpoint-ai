import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import nodemailer from "nodemailer";
import * as cheerio from "cheerio";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const SITE_BASE = "https://www.truck-point.net";

const CATALOG_PAGES = [
  {
    type: "truck",
    url: `${SITE_BASE}/trucks`
  },
  {
    type: "trailer",
    url: `${SITE_BASE}/trailers`
  }
];

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true") === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

let catalog = [];

const syncStatus = {
  started_at: null,
  finished_at: null,
  last_error: null,
  items: 0,
  trucks: 0,
  trailers: 0
};


/* =========================================================
   HELPERS
========================================================= */

function absoluteUrl(url) {
  if (!url) return "";

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }

  if (url.startsWith("/")) {
    return `${SITE_BASE}${url}`;
  }

  return `${SITE_BASE}/${url}`;
}


function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function parsePrice(value) {
  if (!value) return null;

  const text = String(value)
    .replace(/\s/g, "")
    .replace(",", ".");

  const match = text.match(/€?\s*([\d.]+)/);

  if (!match) return null;

  const number = Number(match[1]);

  return Number.isFinite(number) ? number : null;
}


function parseNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value)
    .replace(/\s/g, "")
    .replace(",", ".");

  const match = text.match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  const number = Number(match[0]);

  return Number.isFinite(number) ? number : null;
}


/* =========================================================
   SPEC PARSING
========================================================= */

function parseSpecs(description) {
  const result = {};

  const lines = String(description || "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separator = line.indexOf(":");

    if (separator === -1) continue;

    const key = line
      .slice(0, separator)
      .trim();

    const value = line
      .slice(separator + 1)
      .trim();

    if (!key || !value) continue;

    result[key] = value;
  }

  return result;
}


function normalizeSpecs(raw) {
  const specs = {};

  specs.make_model =
    raw["Make/Model"] ||
    raw["Make / Model"] ||
    raw["Model"] ||
    raw["Make"] ||
    null;

  specs.year =
    parseNumber(raw["Year"]) ||
    null;

  specs.mileage_km =
    parseNumber(
      raw["Mileage"] ||
      raw["Mileage km"] ||
      raw["Mileage (km)"]
    ) || null;

  specs.engine =
    raw["Engine"] ||
    null;

  specs.engine_l =
    parseNumber(specs.engine) ||
    null;

  specs.power_hp =
    parseNumber(
      raw["Power"] ||
      raw["Power HP"] ||
      raw["Horsepower"]
    ) || null;

  if (!specs.power_hp && specs.engine) {
    const hpMatch = String(specs.engine).match(
      /(\d+(?:\.\d+)?)\s*HP/i
    );

    if (hpMatch) {
      specs.power_hp = Number(hpMatch[1]);
    }
  }

  specs.emission =
    raw["Emission"] ||
    raw["Emission class"] ||
    raw["Euro"] ||
    null;

  specs.axle_configuration =
    raw["Axle Configuration"] ||
    raw["Axle configuration"] ||
    raw["Axles"] ||
    null;

  specs.cab =
    raw["Cab"] ||
    null;

  specs.park_cool =
    raw["Park cool"] ||
    raw["Parking cooler"] ||
    null;

  specs.retarder =
    raw["Retarder"] ||
    null;

  specs.location =
    raw["Location"] ||
    null;

  specs.quantity =
    parseNumber(raw["Quantity"]) ||
    null;

  return specs;
}


/* =========================================================
   HTTP / HTML
========================================================= */

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; TruckPointAI/1.0)"
    }
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} while fetching ${url}`
    );
  }

  return await response.text();
}


/* =========================================================
   LIST PAGE PARSER
========================================================= */

function parseListPage(html, type) {
  const $ = cheerio.load(html);

  const items = [];

  $(".t404__link").each((index, element) => {
    const link = $(element);

    const href = link.attr("href");

    if (!href) return;

    const title =
      cleanText(
        link
          .find(".t404__title")
          .first()
          .text()
      ) ||
      cleanText(
        link
          .find(".t404__textwrapper")
          .first()
          .text()
      );

    const priceText =
      cleanText(
        link
          .find(".t404__descr")
          .first()
          .text()
      );

    const price = parsePrice(priceText);

    let image = "";

    const imageElement =
      link
        .find(".t404__img")
        .first();

    if (imageElement.length) {
      image =
        imageElement.attr("data-original") ||
        imageElement.attr("src") ||
        "";
    }

    items.push({
      type,
      title,
      price_eur: price,
      url: absoluteUrl(href),
      image: absoluteUrl(image),
      details_loaded: false
    });
  });

  return items;
}


/* =========================================================
   DETAIL PAGE PARSER
========================================================= */

function parseDetailPage(html, item) {
  const $ = cheerio.load(html);

  const title =
    cleanText(
      $(".t764__title.js-product-name")
        .first()
        .text()
    ) ||
    cleanText(
      $("title")
        .first()
        .text()
    ) ||
    item.title;

  const descriptionElement =
    $(".t764__descr.field").first().length
      ? $(".t764__descr.field").first()
      : $(".t764__descr").first();

  const description =
    descriptionElement
      .clone()
      .find("br")
      .replaceWith("\n")
      .end()
      .text();

  const rawSpecs = parseSpecs(description);

  const specs = normalizeSpecs(rawSpecs);

  /* -----------------------------------------
     Images
  ----------------------------------------- */

  const images = [];

  $(".t-slds__bgimg").each((index, element) => {
    const el = $(element);

    const image =
      el.attr("data-img-zoom-url") ||
      el.attr("data-original") ||
      el.attr("data-image") ||
      el.attr("style") ||
      "";

    let imageUrl = image;

    const urlMatch =
      String(image).match(
        /url\(['"]?([^'")]+)['"]?\)/
      );

    if (urlMatch) {
      imageUrl = urlMatch[1];
    }

    if (imageUrl) {
      const absolute = absoluteUrl(imageUrl);

      if (!images.includes(absolute)) {
        images.push(absolute);
      }
    }
  });

  /* -----------------------------------------
     Meta description / price fallback
  ----------------------------------------- */

  const metaDescription =
    cleanText(
      $('meta[name="description"]')
        .attr("content")
    );

  const priceFromPage =
    parsePrice(metaDescription) ||
    item.price_eur;

  return {
    ...item,

    title,

    price_eur: priceFromPage,

    ...specs,

    images,

    description_raw:
      cleanText(description),

    details_loaded: true
  };
}


/* =========================================================
   ENRICHMENT
========================================================= */

async function enrichItem(item) {
  try {
    const html = await fetchHtml(item.url);

    return parseDetailPage(html, item);
  } catch (error) {
    console.error(
      `Failed to enrich ${item.url}:`,
      error.message
    );

    return {
      ...item,
      details_loaded: false,
      details_error: error.message
    };
  }
}


async function enrichItems(items) {
  const result = [];

  for (const item of items) {
    const enriched = await enrichItem(item);

    result.push(enriched);
  }

  return result;
}


/* =========================================================
   CATALOG SYNC
========================================================= */

async function syncCatalog() {
  syncStatus.started_at =
    new Date().toISOString();

  syncStatus.last_error = null;

  try {
    let allItems = [];

    for (const page of CATALOG_PAGES) {
      console.log(
        `Fetching catalog page: ${page.url}`
      );

      const html =
        await fetchHtml(page.url);

      const items =
        parseListPage(
          html,
          page.type
        );

      console.log(
        `Found ${items.length} ${page.type} listings`
      );

      allItems.push(...items);
    }

    console.log(
      `Total listings found: ${allItems.length}`
    );

    const enriched =
      await enrichItems(allItems);

    catalog = enriched;

    syncStatus.items =
      catalog.length;

    syncStatus.trucks =
      catalog.filter(
        item => item.type === "truck"
      ).length;

    syncStatus.trailers =
      catalog.filter(
        item => item.type === "trailer"
      ).length;

    syncStatus.finished_at =
      new Date().toISOString();

    console.log(
      `Catalog sync complete: ${catalog.length} items`
    );
  } catch (error) {
    syncStatus.last_error =
      error.message;

    syncStatus.finished_at =
      new Date().toISOString();

    console.error(
      "Catalog sync failed:",
      error
    );
  }
}


/* =========================================================
   SEARCH HELPERS
========================================================= */

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/[×]/g, "x")
    .replace(/[^\p{L}\p{N}.€$£+\-x\s]/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function tokenize(text) {
  return normalizeSearchText(text)
    .split(/\s+/)
    .filter(token => token.length >= 2);
}


function extractBudget(text) {
  const normalized =
    normalizeSearchText(text);

  const patterns = [
    /(?:up to|max(?:imum)?|under|below|less than|budget(?: of)?|до|не более|максимум)\s*(?:€|\$|£)?\s*([\d\s.,]+)/i,

    /(?:€|\$|£)\s*([\d\s.,]+)\s*(?:max|maximum|до)?/i
  ];

  for (const pattern of patterns) {
    const match =
      normalized.match(pattern);

    if (!match) continue;

    const raw =
      match[1]
        .replace(/\s/g, "")
        .replace(/,/g, "");

    const value =
      Number(raw);

    if (
      Number.isFinite(value) &&
      value > 0
    ) {
      return value;
    }
  }

  return null;
}


function extractYear(text) {
  const match =
    String(text || "").match(
      /\b(19\d{2}|20\d{2})\b/g
    );

  if (!match) return [];

  return [
    ...new Set(
      match.map(Number)
    )
  ];
}


function extractEuroClasses(text) {
  const normalized =
    normalizeSearchText(text);

  const matches =
    normalized.match(
      /\beuro\s*([0-6])\b/g
    ) || [];

  return [
    ...new Set(
      matches.map(value => {
        const match =
          value.match(/([0-6])/);

        return match
          ? Number(match[1])
          : null;
      }).filter(Boolean)
    )
  ];
}


function detectVehicleTypes(text) {
  const normalized =
    normalizeSearchText(text);

  const truckWords = [
    "truck",
    "tractor",
    "tractor unit",
    "тягач",
    "truck unit",
    "lorry"
  ];

  const trailerWords = [
    "trailer",
    "semi trailer",
    "semi-trailer",
    "прицеп",
    "полуприцеп"
  ];

  const hasTruck =
    truckWords.some(word =>
      normalized.includes(word)
    );

  const hasTrailer =
    trailerWords.some(word =>
      normalized.includes(word)
    );

  if (hasTruck && !hasTrailer) {
    return ["truck"];
  }

  if (hasTrailer && !hasTruck) {
    return ["trailer"];
  }

  return [];
}


function detectBrands(text) {
  const normalized =
    normalizeSearchText(text);

  const brands = [
    "volvo",
    "scania",
    "daf",
    "mercedes",
    "mercedes-benz",
    "mb",
    "man",
    "iveco",
    "renault",
    "ford",
    "krone",
    "schmitz",
    "kogel",
    "wielton"
  ];

  return brands.filter(
    brand =>
      normalized.includes(brand)
  );
}


function hasEuroClass(item, euroClass) {
  if (!item.emission) {
    return false;
  }

  const normalized =
    normalizeSearchText(
      item.emission
    );

  return normalized.includes(
    `euro ${euroClass}`
  );
}


function itemMatchesBrand(item, brand) {
  const haystack =
    normalizeSearchText(
      [
        item.title,
        item.make_model
      ]
        .filter(Boolean)
        .join(" ")
    );

  if (
    brand === "mercedes" ||
    brand === "mercedes-benz" ||
    brand === "mb"
  ) {
    return (
      haystack.includes("mercedes") ||
      haystack.includes("mb")
    );
  }

  return haystack.includes(
    normalizeSearchText(brand)
  );
}


function itemMatchesNamedVehicle(
  item,
  text
) {
  const normalized =
    normalizeSearchText(text);

  const itemText =
    normalizeSearchText(
      [
        item.title,
        item.make_model
      ]
        .filter(Boolean)
        .join(" ")
    );

  const itemTokens =
    tokenize(itemText)
      .filter(token =>
        ![
          "2014",
          "2015",
          "2016",
          "2017",
          "2018",
          "2019",
          "2020",
          "2021",
          "2022",
          "2023",
          "2024",
          "2025",
          "2026"
        ].includes(token)
      );

  const importantTokens =
    itemTokens.filter(
      token =>
        token.length >= 3
    );

  if (!importantTokens.length) {
    return false;
  }

  const matches =
    importantTokens.filter(
      token =>
        normalized.includes(token)
    );

  const year =
    item.year &&
    normalized.includes(
      String(item.year)
    );

  return (
    matches.length >=
      Math.min(
        2,
        importantTokens.length
      ) &&
    (year || matches.length >= 2)
  );
}


/* =========================================================
   COMPARISON DETECTION
========================================================= */

function isComparisonRequest(text) {
  const normalized =
    normalizeSearchText(text);

  const words = [
    "compare",
    "comparison",
    "versus",
    "vs",
    "difference",
    "differences",
    "compare with",
    "compare it with",
    "сравни",
    "сравнить",
    "сравнение",
    "разница",
    "отличия"
  ];

  return words.some(
    word =>
      normalized.includes(word)
  );
}


function getNamedCatalogItems(text) {
  return catalog.filter(item =>
    itemMatchesNamedVehicle(
      item,
      text
    )
  );
}


/* =========================================================
   SMART CATALOG SEARCH
========================================================= */

function searchCatalog(
  message,
  conversation = []
) {
  const userText =
    String(message || "");

  const normalized =
    normalizeSearchText(
      userText
    );

  if (!normalized) {
    return [];
  }

  const budget =
    extractBudget(userText);

  const years =
    extractYear(userText);

  const euroClasses =
    extractEuroClasses(userText);

  const brands =
    detectBrands(userText);

  const vehicleTypes =
    detectVehicleTypes(userText);

  const comparison =
    isComparisonRequest(userText);

  /*
   * -------------------------------------------------------
   * 1. Explicitly named vehicles in current message
   * -------------------------------------------------------
   */

  const explicitlyNamed =
    getNamedCatalogItems(
      userText
    );

  /*
   * -------------------------------------------------------
   * 2. Referenced vehicle from previous conversation
   *
   * This is important for:
   *
   * "Compare it with DAF XF 460 2017"
   *
   * We keep the vehicle mentioned immediately before.
   * -------------------------------------------------------
   */

  const conversationText =
    conversation
      .map(message => {
        if (
          !message ||
          !message.content
        ) {
          return "";
        }

        return String(
          message.content
        );
      })
      .join("\n");

  const previousNamed =
    getNamedCatalogItems(
      conversationText
    );

  /*
   * -------------------------------------------------------
   * 3. Comparison mode
   *
   * Return all explicitly mentioned vehicles
   * plus the referenced previous vehicle.
   * -------------------------------------------------------
   */

  if (comparison) {
    const comparisonItems = [
      ...explicitlyNamed,
      ...previousNamed
    ];

    const unique = [];

    for (const item of comparisonItems) {
      if (
        !unique.some(
          existing =>
            existing.url === item.url
        )
      ) {
        unique.push(item);
      }
    }

    /*
     * If we found named vehicles,
     * comparison should use them directly.
     */
    if (unique.length >= 2) {
      return unique;
    }

    /*
     * If only one explicit vehicle was found,
     * return it plus other likely candidates.
     */
    if (unique.length === 1) {
      const extras =
        catalog
          .filter(
            item =>
              item.url !==
              unique[0].url
          )
          .slice(0, 5);

      return [
        ...unique,
        ...extras
      ];
    }
  }

  /*
   * -------------------------------------------------------
   * 4. General candidate selection
   * -------------------------------------------------------
   */

  let candidates = [
    ...catalog
  ];

  /*
   * Vehicle type
   */
  if (vehicleTypes.length) {
    candidates =
      candidates.filter(
        item =>
          vehicleTypes.includes(
            item.type
          )
      );
  }

  /*
   * Budget
   */
  if (budget !== null) {
    candidates =
      candidates.filter(
        item =>
          item.price_eur !== null &&
          item.price_eur <= budget
      );
  }

  /*
   * Euro class
   */
  if (euroClasses.length) {
    candidates =
      candidates.filter(item =>
        euroClasses.some(
          euro =>
            hasEuroClass(
              item,
              euro
            )
        )
      );
  }

  /*
   * Brand logic:
   *
   * Volvo OR Scania
   * rather than Volvo AND Scania.
   */
  if (brands.length) {
    candidates =
      candidates.filter(item =>
        brands.some(
          brand =>
            itemMatchesBrand(
              item,
              brand
            )
        )
      );
  }

  /*
   * Year
   *
   * If a year is explicitly mentioned,
   * keep vehicles matching it.
   */
  if (years.length) {
    candidates =
      candidates.filter(
        item =>
          item.year &&
          years.includes(
            Number(item.year)
          )
      );
  }

  /*
   * -------------------------------------------------------
   * 5. Explicit model query
   * -------------------------------------------------------
   */

  const hasSpecificModel =
    explicitlyNamed.length > 0;

  if (hasSpecificModel) {
    const specific = [
      ...explicitlyNamed
    ];

    const rest =
      candidates.filter(
        item =>
          !specific.some(
            selected =>
              selected.url ===
              item.url
          )
      );

    candidates = [
      ...specific,
      ...rest
    ];
  }

  /*
   * -------------------------------------------------------
   * 6. If there are no structured filters,
   * use token relevance.
   * -------------------------------------------------------
   */

  const hasStructuredFilters =
    budget !== null ||
    euroClasses.length > 0 ||
    brands.length > 0 ||
    years.length > 0 ||
    vehicleTypes.length > 0 ||
    hasSpecificModel;

  if (
    !hasStructuredFilters &&
    !comparison
  ) {
    const queryTokens =
      tokenize(userText);

    const scored =
      catalog.map(item => {
        const text =
          normalizeSearchText(
            [
              item.title,
              item.make_model,
              item.description_raw
            ]
              .filter(Boolean)
              .join(" ")
          );

        let score = 0;

        for (const token of queryTokens) {
          if (
            text.includes(token)
          ) {
            score += 1;
          }
        }

        return {
          item,
          score
        };
      });

    scored.sort(
      (a, b) =>
        b.score - a.score
    );

    return scored
      .filter(
        result =>
          result.score > 0
      )
      .slice(0, 12)
      .map(result =>
        result.item
      );
  }

  /*
   * Keep result set useful.
   */
  return candidates.slice(0, 20);
}


/* =========================================================
   CATALOG CONTEXT FOR AI
========================================================= */

function buildCatalogContext(items) {
  if (!items.length) {
    return "No matching catalog vehicles were found.";
  }

  return items
    .map((item, index) => {
      return `
CATALOG ITEM ${index + 1}

Type: ${item.type || "not specified"}
Title: ${item.title || "not specified"}
Price EUR: ${
        item.price_eur !== null &&
        item.price_eur !== undefined
          ? `€${item.price_eur.toLocaleString("en-US")}`
          : "not specified"
      }

Make/Model: ${
        item.make_model || "not specified"
      }

Year: ${
        item.year || "not specified"
      }

Mileage km: ${
        item.mileage_km !== null &&
        item.mileage_km !== undefined
          ? item.mileage_km.toLocaleString(
              "en-US"
            )
          : "not specified"
      }

Engine: ${
        item.engine || "not specified"
      }

Engine liters: ${
        item.engine_l ??
        "not specified"
      }

Power HP: ${
        item.power_hp ??
        "not specified"
      }

Emission: ${
        item.emission ||
        "not specified"
      }

Axle configuration: ${
        item.axle_configuration ||
        "not specified"
      }

Cab: ${
        item.cab ||
        "not specified"
      }

Park cool: ${
        item.park_cool ||
        "not specified"
      }

Retarder: ${
        item.retarder ||
        "not specified"
      }

Location: ${
        item.location ||
        "not specified"
      }

Quantity: ${
        item.quantity ??
        "not specified"
      }

Listed URL: ${
        item.url
      }

Details loaded: ${
        item.details_loaded
          ? "yes"
          : "no"
      }
`;
    })
    .join("\n");
}


/* =========================================================
   AI SYSTEM PROMPT
========================================================= */

function buildSystemPrompt() {
  return `
You are the Truck Point AI Sales Consultant.

You help customers choose commercial trucks, tractor units,
trailers and semi-trailers listed by Truck Point.

The catalog provided in the conversation is the SOURCE OF TRUTH
for vehicle information.

STRICT RULES:

1. Never invent vehicle specifications.

2. Never invent:
- price
- availability
- service history
- accident history
- inspection results
- financing terms
- delivery dates
- transport prices
- discounts
- warranty
- documents
- condition

3. If information is not present in the catalog, say clearly:
"This information is not confirmed in the catalog."

4. Always use the catalog price when discussing a listed vehicle.

5. When recommending vehicles, distinguish:
- facts from the catalog
- your recommendation based on those facts

6. Do not claim that Euro 6 automatically guarantees suitability
for every European route. Explain that actual requirements can
depend on destination, regulations and customer operation.

7. For long-distance transport, you may reasonably compare:
- year
- mileage
- engine power
- axle configuration
- cab
- Euro class
- price

But do not invent mechanical condition or reliability.

8. If the customer asks for a comparison, compare only vehicles
actually present in the catalog context.

9. If the customer asks "compare it with X", understand that
"it" may refer to a vehicle discussed earlier in the conversation.

10. If the customer gives multiple brand preferences such as:
"Volvo or Scania", treat that as OR, not AND.

11. If the customer gives a maximum budget, show vehicles at or
below that budget.

12. If there are several suitable vehicles, show the best
matches first and explain why.

13. Do not overwhelm the customer with every specification if
they did not ask for it. Use concise tables or bullet points.

14. Ask one useful qualification question at a time.

15. Your goal is to help the customer move toward a purchase.

QUALIFICATION:

When appropriate, learn:
- equipment type
- preferred brand/model
- year
- mileage
- engine/power
- transmission if known
- axle configuration
- budget
- country/market
- use case
- purchase timeframe

SALES FLOW:

A good flow is:

1. Understand what the customer needs.
2. Find matching catalog vehicles.
3. Explain the strongest matches.
4. Ask one useful follow-up question.
5. If customer shows serious interest, offer manager contact.
6. Collect name, phone and email.
7. Make clear that the information will be passed to the sales team.

LEAD HANDOFF:

If customer wants:
- more photos
- documents
- inspection
- service history
- transport
- financing
- negotiation
- availability confirmation
- purchase assistance

offer to connect them with a manager.

Do not pretend that you personally confirmed those things.

LANGUAGE:

Reply in the language used by the customer.
You can communicate in English, Russian, German, Polish,
Latvian and other languages.

STYLE:

Professional, concise, helpful and sales-oriented.
Do not sound robotic.

IMPORTANT:

The customer may ask broad questions such as:
"What would you recommend?"

Give a recommendation based only on catalog facts and clearly
state the trade-off.

Never say something like:
"lower mileage means longer remaining life"
as a factual guarantee.

Instead say:
"the DAF has lower recorded mileage and is newer, which may
make it more attractive if those factors are important to you."
`;
}


/* =========================================================
   CHAT ENDPOINT
========================================================= */

app.post("/api/chat", async (req, res) => {
  try {
    const {
      message,
      messages = []
    } = req.body || {};

    const userText =
      String(message || "").trim();

    if (!userText) {
      return res.status(400).json({
        error: "Message is required"
      });
    }

    /*
     * Keep the conversation reasonably small.
     */
    const conversation =
      Array.isArray(messages)
        ? messages.slice(-12)
        : [];

    /*
     * IMPORTANT:
     * Search using current message AND conversation
     * so comparison references work.
     */
    const matchingCatalog =
      searchCatalog(
        userText,
        conversation
      );

    console.log(
      "CHAT:",
      userText
    );

    console.log(
      "MATCHING CATALOG:",
      matchingCatalog.map(
        item => ({
          title: item.title,
          price: item.price_eur,
          url: item.url
        })
      )
    );

    const catalogContext =
      buildCatalogContext(
        matchingCatalog
      );

    const aiMessages = [
      {
        role: "system",
        content:
          buildSystemPrompt()
      },

      {
        role: "system",
        content: `
CURRENT CATALOG CONTEXT

${catalogContext}
`
      },

      ...conversation
        .filter(
          item =>
            item &&
            (
              item.role === "user" ||
              item.role === "assistant"
            )
        )
        .map(item => ({
          role: item.role,
          content: String(
            item.content || ""
          )
        })),

      {
        role: "user",
        content: userText
      }
    ];

    const completion =
      await openai.chat.completions.create({
        model:
          process.env.OPENAI_MODEL ||
          "gpt-5-mini",

        messages:
          aiMessages
      });

    const reply =
      completion.choices?.[0]?.message?.content ||
      "Sorry, I could not generate a response.";

    return res.json({
      reply,
      catalog: matchingCatalog.map(
        item => ({
          title: item.title,
          price_eur: item.price_eur,
          url: item.url
        })
      )
    });

  } catch (error) {
    console.error(
      "CHAT ERROR:",
      error
    );

    return res.status(500).json({
      error:
        "Something went wrong while processing the request."
    });
  }
});


/* =========================================================
   LEAD ENDPOINT
========================================================= */

app.post("/api/lead", async (req, res) => {
  try {
    const {
      name,
      phone,
      email,
      language,
      equipment_type,
      brand_model,
      listing_url,
      budget,
      timeframe,
      use_case,
      question,
      objections,
      stage,
      ai_summary,
      manager_status,
      follow_up
    } = req.body || {};

    const subject =
      `Truck Point AI Lead — ${
        brand_model ||
        equipment_type ||
        "New inquiry"
      }`;

    const html = `
      <h2>New Truck Point AI Lead</h2>

      <p><strong>Name:</strong> ${name || "-"}</p>
      <p><strong>Phone:</strong> ${phone || "-"}</p>
      <p><strong>Email:</strong> ${email || "-"}</p>
      <p><strong>Language:</strong> ${language || "-"}</p>

      <hr>

      <p><strong>Equipment type:</strong> ${
        equipment_type || "-"
      }</p>

      <p><strong>Brand / Model:</strong> ${
        brand_model || "-"
      }</p>

      <p><strong>Listing URL:</strong> ${
        listing_url || "-"
      }</p>

      <p><strong>Budget:</strong> ${
        budget || "-"
      }</p>

      <p><strong>Purchase timeframe:</strong> ${
        timeframe || "-"
      }</p>

      <p><strong>Use case:</strong> ${
        use_case || "-"
      }</p>

      <hr>

      <p><strong>Customer question:</strong><br>
      ${question || "-"}</p>

      <p><strong>Objections:</strong><br>
      ${objections || "-"}</p>

      <p><strong>Stage:</strong> ${
        stage || "-"
      }</p>

      <p><strong>AI summary:</strong><br>
      ${ai_summary || "-"}</p>

      <p><strong>Manager status:</strong> ${
        manager_status || "-"
      }</p>

      <p><strong>Follow-up:</strong><br>
      ${follow_up || "-"}</p>
    `;

    await transporter.sendMail({
      from:
        process.env.SMTP_USER,

      to:
        process.env.LEAD_TO_EMAIL,

      subject,

      html
    });

    return res.json({
      success: true
    });

  } catch (error) {
    console.error(
      "LEAD ERROR:",
      error
    );

    return res.status(500).json({
      error:
        "Could not send lead."
    });
  }
});


/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,

    catalog_items:
      catalog.length,

    trucks:
      catalog.filter(
        item =>
          item.type === "truck"
      ).length,

    trailers:
      catalog.filter(
        item =>
          item.type === "trailer"
      ).length,

    sync: syncStatus
  });
});


app.get("/", (req, res) => {
  res.send(
    "Truck Point AI backend is running."
  );
});


/* =========================================================
   START
========================================================= */

app.listen(PORT, async () => {
  console.log(
    `Truck Point AI server running on port ${PORT}`
  );

  await syncCatalog();

  setInterval(
    syncCatalog,
    30 * 60 * 1000
  );
});
