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

/* =========================================================
   OPENAI
========================================================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 20000,
  maxRetries: 0
});

/* =========================================================
   SMTP
========================================================= */

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure:
    String(process.env.SMTP_SECURE || "true") === "true",

  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },

  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000
});

/* =========================================================
   GLOBALS
========================================================= */

let catalog = [];

let catalogReadyPromise = null;

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

  if (
    url.startsWith("http://") ||
    url.startsWith("https://")
  ) {
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parsePrice(value) {
  if (!value) return null;

  const text = String(value)
    .replace(/\s/g, "")
    .replace(",", ".");

  const match =
    text.match(/€?\s*([\d.]+)/);

  if (!match) return null;

  const number = Number(match[1]);

  return Number.isFinite(number)
    ? number
    : null;
}

function parseNumber(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text = String(value)
    .replace(/\s/g, "")
    .replace(",", ".");

  const match =
    text.match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  const number = Number(match[0]);

  return Number.isFinite(number)
    ? number
    : null;
}

/* =========================================================
   TIMEOUT HELPER
========================================================= */

function withTimeout(
  promise,
  milliseconds,
  label = "Operation"
) {
  let timer;

  const timeoutPromise =
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${label} timed out after ${milliseconds} ms`
          )
        );
      }, milliseconds);
    });

  return Promise.race([
    promise,
    timeoutPromise
  ]).finally(() => {
    clearTimeout(timer);
  });
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
    const separator =
      line.indexOf(":");

    if (separator === -1) continue;

    const key =
      line
        .slice(0, separator)
        .trim();

    const value =
      line
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

  if (
    !specs.power_hp &&
    specs.engine
  ) {
    const hpMatch =
      String(specs.engine).match(
        /(\d+(?:\.\d+)?)\s*HP/i
      );

    if (hpMatch) {
      specs.power_hp =
        Number(hpMatch[1]);
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
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      12000
    );

  try {
    const response =
      await fetch(url, {
        signal: controller.signal,

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

  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `Request timed out while fetching ${url}`
      );
    }

    throw error;

  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   LIST PAGE PARSER
========================================================= */

function parseListPage(
  html,
  type
) {
  const $ =
    cheerio.load(html);

  const items = [];

  $(".t404__link").each(
    (index, element) => {
      const link =
        $(element);

      const href =
        link.attr("href");

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

      const price =
        parsePrice(priceText);

      let image = "";

      const imageElement =
        link
          .find(".t404__img")
          .first();

      if (imageElement.length) {
        image =
          imageElement.attr(
            "data-original"
          ) ||
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
    }
  );

  return items;
}

/* =========================================================
   DETAIL PAGE PARSER
========================================================= */

function parseDetailPage(
  html,
  item
) {
  const $ =
    cheerio.load(html);

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

  const rawSpecs =
    parseSpecs(description);

  const specs =
    normalizeSpecs(rawSpecs);

  /* -----------------------------------------
     Images
  ----------------------------------------- */

  const images = [];

  $(".t-slds__bgimg").each(
    (index, element) => {
      const el =
        $(element);

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
        imageUrl =
          urlMatch[1];
      }

      if (imageUrl) {
        const absolute =
          absoluteUrl(imageUrl);

        if (
          !images.includes(
            absolute
          )
        ) {
          images.push(
            absolute
          );
        }
      }
    }
  );

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

    price_eur:
      priceFromPage,

    ...specs,

    images,

    description_raw:
      cleanText(description),

    details_loaded:
      true
  };
}

/* =========================================================
   ENRICHMENT
========================================================= */

async function enrichItem(item) {
  try {
    const html =
      await fetchHtml(item.url);

    return parseDetailPage(
      html,
      item
    );

  } catch (error) {
    console.error(
      `Failed to enrich ${item.url}:`,
      error.message
    );

    return {
      ...item,

      details_loaded:
        false,

      details_error:
        error.message
    };
  }
}

async function enrichItems(items) {
  const result = [];

  for (const item of items) {
    const enriched =
      await enrichItem(item);

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

  syncStatus.last_error =
    null;

  try {
    let allItems = [];

    for (
      const page of CATALOG_PAGES
    ) {
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

      allItems.push(
        ...items
      );
    }

    console.log(
      `Total listings found: ${allItems.length}`
    );

    const enriched =
      await enrichItems(
        allItems
      );

    catalog =
      enriched;

    syncStatus.items =
      catalog.length;

    syncStatus.trucks =
      catalog.filter(
        item =>
          item.type === "truck"
      ).length;

    syncStatus.trailers =
      catalog.filter(
        item =>
          item.type === "trailer"
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
    .replace(
      /[^\p{L}\p{N}.€$£+\-x\s]/giu,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeSearchText(text)
    .split(/\s+/)
    .filter(
      token =>
        token.length >= 2
    );
}

function extractBudget(text) {
  const normalized =
    normalizeSearchText(text);

  const patterns = [
    /(?:up to|max(?:imum)?|under|below|less than|budget(?: of)?|до|не более|максимум)\s*(?:€|\$|£)?\s*([\d\s.,]+)/i,

    /(?:€|\$|£)\s*([\d\s.,]+)\s*(?:max|maximum|до)?/i
  ];

  for (
    const pattern of patterns
  ) {
    const match =
      normalized.match(
        pattern
      );

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
      matches
        .map(value => {
          const match =
            value.match(
              /([0-6])/
            );

          return match
            ? Number(match[1])
            : null;
        })
        .filter(
          value =>
            value !== null
        )
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
    truckWords.some(
      word =>
        normalized.includes(
          word
        )
    );

  const hasTrailer =
    trailerWords.some(
      word =>
        normalized.includes(
          word
        )
    );

  if (
    hasTruck &&
    !hasTrailer
  ) {
    return ["truck"];
  }

  if (
    hasTrailer &&
    !hasTruck
  ) {
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
      normalized.includes(
        brand
      )
  );
}

function hasEuroClass(
  item,
  euroClass
) {
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

function itemMatchesBrand(
  item,
  brand
) {
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
      haystack.includes(
        "mercedes"
      ) ||
      haystack.includes("mb")
    );
  }

  return haystack.includes(
    normalizeSearchText(
      brand
    )
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
      .filter(
        token =>
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

  if (
    !importantTokens.length
  ) {
    return false;
  }

  const matches =
    importantTokens.filter(
      token =>
        normalized.includes(
          token
        )
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
    (
      year ||
      matches.length >= 2
    )
  );
}

/* =========================================================
   COMPARISON
========================================================= */

function isComparisonRequest(
  text
) {
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
      normalized.includes(
        word
      )
  );
}

function getNamedCatalogItems(
  text
) {
  return catalog.filter(
    item =>
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
    extractBudget(
      userText
    );

  const years =
    extractYear(
      userText
    );

  const euroClasses =
    extractEuroClasses(
      userText
    );

  const brands =
    detectBrands(
      userText
    );

  const vehicleTypes =
    detectVehicleTypes(
      userText
    );

  const comparison =
    isComparisonRequest(
      userText
    );

  const explicitlyNamed =
    getNamedCatalogItems(
      userText
    );

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

  if (comparison) {
    const comparisonItems = [
      ...explicitlyNamed,
      ...previousNamed
    ];

    const unique = [];

    for (
      const item of comparisonItems
    ) {
      if (
        !unique.some(
          existing =>
            existing.url ===
            item.url
        )
      ) {
        unique.push(item);
      }
    }

    if (
      unique.length >= 2
    ) {
      return unique;
    }

    if (
      unique.length === 1
    ) {
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

  let candidates = [
    ...catalog
  ];

  if (
    vehicleTypes.length
  ) {
    candidates =
      candidates.filter(
        item =>
          vehicleTypes.includes(
            item.type
          )
      );
  }

  if (
    budget !== null
  ) {
    candidates =
      candidates.filter(
        item =>
          item.price_eur !== null &&
          item.price_eur <=
            budget
      );
  }

  if (
    euroClasses.length
  ) {
    candidates =
      candidates.filter(
        item =>
          euroClasses.some(
            euro =>
              hasEuroClass(
                item,
                euro
              )
          )
      );
  }

  if (
    brands.length
  ) {
    candidates =
      candidates.filter(
        item =>
          brands.some(
            brand =>
              itemMatchesBrand(
                item,
                brand
              )
          )
      );
  }

  if (
    years.length
  ) {
    candidates =
      candidates.filter(
        item =>
          item.year &&
          years.includes(
            Number(item.year)
          )
      );
  }

  const hasSpecificModel =
    explicitlyNamed.length > 0;

  if (
    hasSpecificModel
  ) {
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

        for (
          const token of queryTokens
        ) {
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
      .map(
        result =>
          result.item
      );
  }

  return candidates.slice(
    0,
    20
  );
}

/* =========================================================
   CATALOG CONTEXT
========================================================= */

function buildCatalogContext(
  items
) {
  if (!items.length) {
    return (
      "No matching catalog vehicles were found."
    );
  }

  return items
    .map(
      (item, index) => {
        return `
CATALOG ITEM ${index + 1}

Type: ${
          item.type ||
          "not specified"
        }

Title: ${
          item.title ||
          "not specified"
        }

Price EUR: ${
          item.price_eur !== null &&
          item.price_eur !== undefined
            ? `€${item.price_eur.toLocaleString(
                "en-US"
              )}`
            : "not specified"
        }

Make/Model: ${
          item.make_model ||
          "not specified"
        }

Year: ${
          item.year ||
          "not specified"
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
          item.engine ||
          "not specified"
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
      }
    )
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
for every European route.

7. For long-distance transport, you may compare:
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
"it" may refer to a vehicle discussed earlier.

10. Multiple brand preferences such as:
"Volvo or Scania"
mean OR, not AND.

11. If the customer gives a maximum budget, show vehicles at or
below that budget.

12. If several vehicles match, show the strongest matches first.

13. Do not overwhelm the customer with every specification.

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

1. Understand the customer's needs.
2. Find matching catalog vehicles.
3. Explain the strongest matches.
4. Ask one useful follow-up question.
5. If the customer shows serious buying interest,
   offer manager contact.
6. Collect name, phone and email.
7. Explain that the information will be passed to the sales team.

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
- manager contact

offer to connect them with a manager.

Do not pretend that you personally confirmed these things.

IMPORTANT SALES INTENT:

Treat these as strong purchase intent:
- "I want to buy"
- "I am interested in this truck"
- "Is it available?"
- "Can you contact me?"
- "Please send documents"
- "Can you check availability?"
- "I want to reserve it"
- "I want to purchase within..."
- "Can I speak to a manager?"
- "Can you arrange transport?"
- "What is the final price?"

In such cases, encourage the customer to leave contact details.

When the customer explicitly asks to contact a manager,
connect them to the manager lead form immediately.

LANGUAGE:

Reply in the language used by the customer.
You can communicate in English, Russian, German, Polish,
Latvian and other languages.

STYLE:

Professional, concise, helpful and sales-oriented.
Do not sound robotic.

Never make guarantees about vehicle condition,
reliability or remaining service life.
`;
}

/* =========================================================
   LEAD INTENT
========================================================= */

function detectLeadIntent(text) {
  const normalized =
    normalizeSearchText(text);

  const strongIntentPatterns = [

    /* =========================
       ENGLISH
    ========================= */

    /\bi want to buy\b/i,
    /\bi want to purchase\b/i,
    /\bi would like to buy\b/i,
    /\bi am interested in (this|the|a) (truck|tractor|trailer|vehicle)\b/i,

    /\bis it available\b/i,
    /\bis this available\b/i,

    /\bplease contact me\b/i,
    /\bcontact me\b/i,
    /\bcan you contact me\b/i,
    /\bcall me\b/i,
    /\bplease call me\b/i,

    /\bcan i speak to (a )?manager\b/i,
    /\bspeak to (a )?manager\b/i,
    /\bmanager contact\b/i,

    /\bconnect me with (a )?manager\b/i,
    /\bput me in touch with (a )?manager\b/i,
    /\bconnect me to (a )?manager\b/i,

    /\bi want to reserve\b/i,
    /\bi want to book\b/i,
    /\bcan i reserve\b/i,

    /\bplease send (me )?(the )?documents\b/i,
    /\bsend me the documents\b/i,
    /\bcan you send documents\b/i,

    /\bcan you check availability\b/i,
    /\bcheck availability\b/i,

    /\bwhat is the final price\b/i,
    /\bfinal price\b/i,

    /\bi want to buy within\b/i,
    /\bi plan to buy within\b/i,

    /* =========================
       RUSSIAN
    ========================= */

    /хочу купить/i,
    /хочу приобрести/i,
    /хочу купить этот/i,
    /интересует этот грузовик/i,
    /интересует этот тягач/i,
    /интересует эта машина/i,
    /интересует этот автомобиль/i,

    /можно купить/i,

    /он в наличии/i,
    /она в наличии/i,
    /есть в наличии/i,

    /свяжитесь со мной/i,
    /свяжи меня с менеджером/i,
    /свяжите меня с менеджером/i,
    /связать меня с менеджером/i,
    /связаться с менеджером/i,
    /связь с менеджером/i,
    /хочу поговорить с менеджером/i,
    /хочу связаться с менеджером/i,
    /соедините с менеджером/i,
    /соедините меня с менеджером/i,

    /позвоните мне/i,
    /перезвоните мне/i,

    /проверить наличие/i,
    /узнать наличие/i,

    /забронировать/i,
    /хочу забронировать/i,

    /пришлите документы/i,
    /отправьте документы/i,
    /нужны документы/i,

    /финальная цена/i,
    /окончательная цена/i,

    /хочу купить в течение/i,
    /планирую купить/i,

    /* =========================
       GERMAN
    ========================= */

    /\bich möchte kaufen\b/i,
    /\bich will kaufen\b/i,
    /\bist es verfügbar\b/i,
    /\bkontaktieren sie mich\b/i,
    /\bverbinden sie mich mit einem mitarbeiter\b/i,
    /\bich möchte mit einem mitarbeiter sprechen\b/i,
    /\bich möchte mit einem manager sprechen\b/i,

    /* =========================
       POLISH
    ========================= */

    /\bchcę kupić\b/i,
    /\bczy jest dostępny\b/i,
    /\bproszę o kontakt\b/i,
    /\bpołącz mnie z menedżerem\b/i,
    /\bchcę porozmawiać z menedżerem\b/i,

    /* =========================
       LATVIAN
    ========================= */

    /\bgribu iegādāties\b/i,
    /\bvai ir pieejams\b/i,
    /\blūdzu sazināties\b/i,
    /\bsavienojiet mani ar vadītāju\b/i,
    /\bgribu runāt ar vadītāju\b/i
  ];

  if (
    strongIntentPatterns.some(
      pattern =>
        pattern.test(normalized)
    )
  ) {
    return true;
  }

  /* =========================
     BUYING TIMEFRAME
  ========================= */

  const hasBuyingTimeframe =
    /\b(within|in the next|next)\s+\d*\s*(week|weeks|month|months|days)\b/i.test(text) ||
    /в течение\s+(недели|месяца|двух недель|двух месяцев)/i.test(text) ||
    /в ближайшее время/i.test(text) ||
    /в этом месяце/i.test(text);

  const hasVehicleInterest =
    /\b(interested in|like|want|looking to buy)\b/i.test(text) ||
    /интересует|нравится|хочу купить|хочу взять|хочу приобрести/i.test(text);

  if (
    hasBuyingTimeframe &&
    hasVehicleInterest
  ) {
    return true;
  }

  return false;
}

/* =========================================================
   CHAT ENDPOINT
========================================================= */

app.post(
  "/api/chat",
  async (req, res) => {
    try {
      const {
        message,
        messages = []
      } = req.body || {};

      const userText =
        String(
          message || ""
        ).trim();

      if (!userText) {
        return res.status(400).json({
          error:
            "Message is required"
        });
      }

      /*
       * Make sure the catalog has had a chance
       * to load before searching it.
       */

      if (catalogReadyPromise) {
        try {
          await withTimeout(
            catalogReadyPromise,
            25000,
            "Catalog initialization"
          );
        } catch (error) {
          console.error(
            "CATALOG READY ERROR:",
            error.message
          );
        }
      }

      const previousConversation =
        Array.isArray(messages)
          ? messages
              .filter(
                item =>
                  item &&
                  (
                    item.role === "user" ||
                    item.role === "assistant"
                  )
              )
              .slice(-12)
          : [];

      const matchingCatalog =
        searchCatalog(
          userText,
          previousConversation
        );

      console.log(
        "CHAT:",
        userText
      );

      console.log(
        "CATALOG SIZE:",
        catalog.length
      );

      console.log(
        "MATCHING CATALOG:",
        matchingCatalog.map(
          item => ({
            title:
              item.title,
            price:
              item.price_eur,
            url:
              item.url
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

        ...previousConversation.map(
          item => ({
            role:
              item.role,
            content:
              String(
                item.content || ""
              )
          })
        ),

        {
          role: "user",
          content:
            userText
        }
      ];

      const completion =
        await withTimeout(
          openai.chat.completions.create(
            {
              model:
                process.env.OPENAI_MODEL ||
                "gpt-5-mini",

              messages:
                aiMessages
            }
          ),
          20000,
          "OpenAI chat request"
        );

      const reply =
        completion
          .choices?.[0]
          ?.message
          ?.content ||
        "Sorry, I could not generate a response.";

      /*
       * Check the current message AND recent conversation.
       *
       * This means that:
       *
       * "свяжите меня с менеджером"
       *
       * immediately returns:
       *
       * show_lead_form: true
       */

      const conversationForIntent = [
        ...previousConversation,
        {
          role: "user",
          content: userText
        }
      ];

      const intentText =
        conversationForIntent
          .map(
            item =>
              String(
                item.content || ""
              )
          )
          .join("\n");

      const showLeadForm =
        detectLeadIntent(
          intentText
        );

      console.log(
        "LEAD INTENT:",
        showLeadForm
      );

      return res.json({
        reply,

        show_lead_form:
          showLeadForm,

        catalog:
          matchingCatalog.map(
            item => ({
              title:
                item.title,

              price_eur:
                item.price_eur,

              url:
                item.url
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
  }
);

/* =========================================================
   AI LEAD EXTRACTION
========================================================= */

async function extractLeadData(
  conversation
) {
  const conversationText =
    conversation
      .map(item => {
        const role =
          item.role === "user"
            ? "CUSTOMER"
            : "AI";

        return (
          `${role}: ` +
          String(
            item.content || ""
          )
        );
      })
      .join("\n\n");

  const completion =
    await withTimeout(
      openai.chat.completions.create(
        {
          model:
            process.env.OPENAI_MODEL ||
            "gpt-5-mini",

          response_format: {
            type: "json_object"
          },

          messages: [
            {
              role: "system",
              content: `
You are a CRM lead extraction assistant for Truck Point,
a commercial truck and trailer sales company.

Analyze the customer conversation and extract ONLY information
that is explicitly stated or strongly supported.

NEVER invent missing information.

Return valid JSON with exactly these fields:

{
  "language": "",
  "equipment_type": "",
  "brand": "",
  "model": "",
  "year": "",
  "budget": "",
  "emission": "",
  "axle_configuration": "",
  "use_case": "",
  "purchase_timeframe": "",
  "interested_vehicles": [],
  "listing_urls": [],
  "customer_question": "",
  "objections": "",
  "ai_summary": "",
  "lead_score": "",
  "stage": "",
  "manager_action": ""
}

Allowed lead_score:
"Hot", "Warm", "Cold", "Unknown"

Allowed stage:
"New", "Qualified", "Negotiation", "Won", "Lost"

HOT:
- customer asks about availability
- customer wants to buy soon
- customer asks for manager contact
- customer asks for documents
- customer asks about inspection
- customer asks about transport
- customer asks about payment
- customer identifies a specific vehicle
- customer clearly says they want to buy
- customer gives strong purchase timeframe

WARM:
- specific vehicle is discussed
- budget is discussed
- customer compares vehicles
- customer has clear requirements
- purchase intent exists but is not immediate

COLD:
- general information only
- browsing
- educational questions
- no clear buying intent

Unknown:
- insufficient information

Stage:

New:
- initial inquiry

Qualified:
- clear equipment requirements,
  budget, use case or vehicle

Negotiation:
- price, availability, transport,
  financing, documents, inspection,
  payment, manager or purchase details

Won:
- ONLY if purchase is explicitly completed

Lost:
- ONLY if customer explicitly says they will not proceed

interested_vehicles:
Include vehicles the customer clearly asks about,
selects, or shows interest in.

listing_urls:
Include ONLY URLs actually present in the conversation.

ai_summary:
Write a concise 1-3 sentence summary for the sales manager.

manager_action:
Write the most useful next action for the manager.

If unknown, use an empty string.
If none, use [].

Return JSON only.
`
            },

            {
              role: "user",
              content:
                conversationText
            }
          ]
        }
      ),
      20000,
      "OpenAI lead extraction"
    );

  let data = {};

  try {
    data =
      JSON.parse(
        completion
          .choices?.[0]
          ?.message
          ?.content || "{}"
      );

  } catch (error) {
    console.error(
      "LEAD AI JSON ERROR:",
      error
    );

    data = {};
  }

  if (
    !Array.isArray(
      data.interested_vehicles
    )
  ) {
    data.interested_vehicles =
      [];
  }

  if (
    !Array.isArray(
      data.listing_urls
    )
  ) {
    data.listing_urls =
      [];
  }

  return data;
}

/* =========================================================
   GOOGLE SHEETS WEBHOOK
========================================================= */

async function sendLeadToGoogleSheets(
  lead
) {
  const webhookUrl =
    process.env.GOOGLE_SHEETS_WEBHOOK_URL;

  if (!webhookUrl) {
    console.log(
      "Google Sheets webhook is not configured. Skipping."
    );

    return {
      success: false,
      skipped: true
    };
  }

  console.log(
    "GOOGLE SHEETS: sending lead..."
  );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      10000
    );

  try {
    const response =
      await fetch(
        webhookUrl,
        {
          method: "POST",

          signal:
            controller.signal,

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(lead)
        }
      );

    const text =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `Google Sheets webhook returned HTTP ${response.status}: ${text}`
      );
    }

    console.log(
      "GOOGLE SHEETS: lead saved successfully"
    );

    return {
      success: true
    };

  } catch (error) {
    if (
      error.name ===
      "AbortError"
    ) {
      console.error(
        "GOOGLE SHEETS ERROR: request timed out"
      );

      return {
        success: false,
        error:
          "Google Sheets request timed out"
      };
    }

    console.error(
      "GOOGLE SHEETS ERROR:",
      error.message
    );

    return {
      success: false,
      error:
        error.message
    };

  } finally {
    clearTimeout(timeout);
  }
}

/* =========================================================
   EMAIL
========================================================= */

async function sendLeadEmail({
  subject,
  text
}) {
  console.log(
    "EMAIL: sending lead..."
  );

  try {
    const result =
      await withTimeout(
        transporter.sendMail({
          from:
            process.env.SMTP_USER,

          to:
            process.env.LEAD_TO_EMAIL,

          subject,

          text
        }),
        15000,
        "SMTP email"
      );

    console.log(
      "EMAIL: lead sent successfully"
    );

    return {
      success: true,
      messageId:
        result.messageId || ""
    };

  } catch (error) {
    console.error(
      "EMAIL ERROR:",
      error.message
    );

    return {
      success: false,
      error:
        error.message
    };
  }
}

/* =========================================================
   LEAD ENDPOINT
========================================================= */

app.post(
  "/api/lead",
  async (req, res) => {
    console.log(
      "========================================"
    );

    console.log(
      "LEAD RECEIVED"
    );

    console.log(
      "Time:",
      new Date().toISOString()
    );

    try {
      const {
        name = "",
        phone = "",
        email = "",
        page_url = "",
        conversation = []
      } = req.body || {};

      console.log(
        "LEAD CONTACT:",
        {
          name,
          phone:
            phone
              ? "[provided]"
              : "[empty]",
          email:
            email
              ? "[provided]"
              : "[empty]"
        }
      );

      const safeConversation =
        Array.isArray(
          conversation
        )
          ? conversation
              .filter(
                item =>
                  item &&
                  (
                    item.role === "user" ||
                    item.role === "assistant"
                  )
              )
              .slice(-30)
          : [];

      if (
        !phone &&
        !email
      ) {
        console.log(
          "LEAD REJECTED: no phone/email"
        );

        return res.status(400).json({
          error:
            "Phone or email is required"
        });
      }

      console.log(
        "LEAD: extracting data with OpenAI..."
      );

      let leadData = {};

      try {
        leadData =
          await extractLeadData(
            safeConversation
          );

      } catch (error) {
        console.error(
          "LEAD AI EXTRACTION FAILED:",
          error.message
        );

        leadData = {
          language: "",
          equipment_type: "",
          brand: "",
          model: "",
          year: "",
          budget: "",
          emission: "",
          axle_configuration: "",
          use_case: "",
          purchase_timeframe: "",
          interested_vehicles: [],
          listing_urls: [],
          customer_question: "",
          objections: "",
          ai_summary:
            "Lead received. AI extraction failed; manager should review the conversation.",
          lead_score:
            "Unknown",
          stage:
            "New",
          manager_action:
            "Review the conversation and contact the customer."
        };
      }

      console.log(
        "LEAD: AI extraction finished"
      );

      const conversationText =
        safeConversation
          .map(item => {
            const role =
              item.role === "user"
                ? "CUSTOMER"
                : "AI";

            return (
              `${role}: ` +
              String(
                item.content || ""
              )
            );
          })
          .join("\n\n");

      const subject =
        `[Truck Point AI] ${
          leadData.lead_score ||
          "New"
        } lead`;

      const interestedVehicles =
        Array.isArray(
          leadData.interested_vehicles
        ) &&
        leadData
          .interested_vehicles
          .length
          ? leadData
              .interested_vehicles
              .join(", ")
          : "Not specified";

      const listingUrls =
        Array.isArray(
          leadData.listing_urls
        ) &&
        leadData
          .listing_urls
          .length
          ? leadData
              .listing_urls
              .join("\n")
          : "Not specified";

      const emailText = `

NEW TRUCK POINT AI LEAD

========================
CONTACT
========================

Name:
${name || "Not provided"}

Phone:
${phone || "Not provided"}

Email:
${email || "Not provided"}

Language:
${leadData.language || "Not specified"}


========================
REQUIREMENTS
========================

Equipment:
${leadData.equipment_type || "Not specified"}

Brand:
${leadData.brand || "Not specified"}

Model:
${leadData.model || "Not specified"}

Year:
${leadData.year || "Not specified"}

Budget:
${leadData.budget || "Not specified"}

Emission:
${leadData.emission || "Not specified"}

Axle configuration:
${leadData.axle_configuration || "Not specified"}

Use case:
${leadData.use_case || "Not specified"}

Purchase timeframe:
${leadData.purchase_timeframe || "Not specified"}


========================
INTEREST
========================

Interested vehicles:
${interestedVehicles}

Listing URLs:
${listingUrls}


========================
SALES INFORMATION
========================

Customer question:
${leadData.customer_question || "Not specified"}

Objections:
${leadData.objections || "None identified"}

AI summary:
${leadData.ai_summary || "Not available"}

Lead score:
${leadData.lead_score || "Unknown"}

Stage:
${leadData.stage || "New"}

Manager action:
${leadData.manager_action || "Review the conversation and contact the customer."}


========================
SOURCE
========================

Page:
${page_url || "Not provided"}


========================
CONVERSATION
========================

${conversationText}

`;

      const lead = {
        date:
          new Date().toISOString(),

        name:
          name || "",

        phone:
          phone || "",

        email:
          email || "",

        language:
          leadData.language || "",

        equipment_type:
          leadData.equipment_type || "",

        brand:
          leadData.brand || "",

        model:
          leadData.model || "",

        year:
          leadData.year || "",

        budget:
          leadData.budget || "",

        emission:
          leadData.emission || "",

        axle_configuration:
          leadData.axle_configuration || "",

        use_case:
          leadData.use_case || "",

        purchase_timeframe:
          leadData.purchase_timeframe || "",

        interested_vehicles:
          leadData.interested_vehicles,

        listing_urls:
          leadData.listing_urls,

        customer_question:
          leadData.customer_question || "",

        objections:
          leadData.objections || "",

        ai_summary:
          leadData.ai_summary || "",

        lead_score:
          leadData.lead_score || "Unknown",

        stage:
          leadData.stage || "New",

        manager_action:
          leadData.manager_action ||
          "Review the conversation and contact the customer.",

        page_url:
          page_url || "",

        conversation:
          safeConversation
      };

      /*
       * EXACT Google Sheets fields.
       *
       * 1 Date
       * 2 Name
       * 3 Phone
       * 4 Email
       * 5 Language
       * 6 Model
       * 7 Year
       * 8 Budget
       * 9 Axles
       * 10 Customer question
       * 11 Manager status
       * 12 Page URL
       * 13 AI summary
       */

      const googleSheetsLead = {
        date:
          lead.date,

        name:
          lead.name,

        phone:
          lead.phone,

        email:
          lead.email,

        language:
          lead.language,

        model:
          lead.model ||
          lead.brand ||
          "",

        year:
          lead.year,

        budget:
          lead.budget,

        axles:
          lead.axle_configuration,

        customer_question:
          lead.customer_question,

        manager_status:
          lead.stage ||
          "New",

        page_url:
          lead.page_url,

        ai_summary:
          lead.ai_summary
      };

      console.log(
        "LEAD: sending email and Google Sheets in parallel..."
      );

      const [
        emailResult,
        sheetsResult
      ] =
        await Promise.all([
          sendLeadEmail({
            subject,
            text: emailText
          }),

          sendLeadToGoogleSheets(
            googleSheetsLead
          )
        ]);

      console.log(
        "LEAD EMAIL RESULT:",
        emailResult
      );

      console.log(
        "LEAD GOOGLE SHEETS RESULT:",
        sheetsResult
      );

      console.log(
        "NEW AI LEAD CREATED"
      );

      console.log(
        "========================================"
      );

      return res.json({
        success: true,

        message:
          "Lead successfully processed",

        email:
          emailResult,

        google_sheets:
          sheetsResult,

        lead: {
          ...leadData,

          name,
          phone,
          email
        }
      });

    } catch (error) {
      console.error(
        "LEAD ERROR:",
        error
      );

      console.log(
        "========================================"
      );

      return res.status(500).json({
        success: false,

        error:
          "Something went wrong while creating the lead."
      });
    }
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
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

      google_sheets:
        Boolean(
          process.env
            .GOOGLE_SHEETS_WEBHOOK_URL
        ),

      email:
        Boolean(
          process.env
            .SMTP_USER
        ) &&
        Boolean(
          process.env
            .LEAD_TO_EMAIL
        ),

      openai:
        Boolean(
          process.env
            .OPENAI_API_KEY
        ),

      sync:
        syncStatus
    });
  }
);

/* =========================================================
   ROOT
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.send(
      "Truck Point AI backend is running."
    );
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  async () => {
    console.log(
      `Truck Point AI server running on port ${PORT}`
    );

    console.log(
      "Starting catalog synchronization..."
    );

    catalogReadyPromise =
      syncCatalog();

    try {
      await catalogReadyPromise;
    } catch (error) {
      console.error(
        "INITIAL CATALOG SYNC ERROR:",
        error.message
      );
    }

    console.log(
      "Initial catalog synchronization finished."
    );

    setInterval(
      () => {
        if (
          syncStatus.started_at &&
          !syncStatus.finished_at
        ) {
          console.log(
            "Catalog sync already running. Skipping scheduled sync."
          );

          return;
        }

        syncStatus.finished_at =
          null;

        catalogReadyPromise =
          syncCatalog();
      },
      30 * 60 * 1000
    );
  }
);
