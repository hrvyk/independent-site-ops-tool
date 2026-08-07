#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const HOST = process.env.SHIP_PROXY_HOST || '127.0.0.1';
const PORT = Number(process.env.SHIP_PROXY_PORT || 8787);

const tokenCache = new Map();

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.end(JSON.stringify(payload));
}

function parseTransitDays(value, fallback = 7) {
    if (value == null) return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.round(value));

    const text = String(value).trim();
    if (!text) return fallback;

    if (/^\d+(\.\d+)?$/.test(text)) return Math.max(1, Math.round(Number(text)));

    const keywordMap = {
        NEXT_DAY: 1,
        ONE_DAY: 1,
        TWO_DAYS: 2,
        THREE_DAYS: 3,
        FOUR_DAYS: 4,
        FIVE_DAYS: 5,
        SIX_DAYS: 6,
        SEVEN_DAYS: 7
    };
    if (keywordMap[text]) return keywordMap[text];

    const maybeDate = Date.parse(text);
    if (!Number.isNaN(maybeDate)) {
        const diffMs = maybeDate - Date.now();
        if (diffMs <= 0) return 1;
        const days = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
        return Math.max(1, days);
    }

    return fallback;
}

function roundTo(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function asNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveChargeableWeight(pkg = {}) {
    const actualWeightKg = Math.max(0, asNumber(pkg.actualWeightKg));
    const lengthCm = Math.max(0, asNumber(pkg.lengthCm));
    const widthCm = Math.max(0, asNumber(pkg.widthCm));
    const heightCm = Math.max(0, asNumber(pkg.heightCm));
    const divisor = Math.max(1, asNumber(pkg.volumetricDivisor || 5000, 5000));
    const volumetricWeightKg = (lengthCm > 0 && widthCm > 0 && heightCm > 0)
        ? roundTo((lengthCm * widthCm * heightCm) / divisor, 6)
        : Math.max(0, asNumber(pkg.volumetricWeightKg));
    const fallbackChargeable = Math.max(0, asNumber(pkg.chargeableWeightKg));
    const chargeableWeightKg = roundTo(Math.max(actualWeightKg, volumetricWeightKg, fallbackChargeable), 6);
    const isBulky = volumetricWeightKg > 0 && volumetricWeightKg > actualWeightKg * 1.15;
    return {
        actualWeightKg: roundTo(actualWeightKg, 6),
        volumetricWeightKg,
        chargeableWeightKg,
        isBulky,
        lengthCm,
        widthCm,
        heightCm
    };
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return {};
    return JSON.parse(text);
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const raw = await response.text();
    let data = {};
    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch (error) {
            data = { raw };
        }
    }
    if (!response.ok) {
        const message = data?.message || data?.errors?.[0]?.message || `HTTP ${response.status}`;
        const err = new Error(message);
        err.status = response.status;
        err.data = data;
        throw err;
    }
    return data;
}

function getBaseUrl(provider, env) {
    const isProd = env === 'production';
    if (provider === 'fedex') {
        if (isProd) return process.env.FEDEX_BASE_URL_PROD || 'https://apis.fedex.com';
        return process.env.FEDEX_BASE_URL_SANDBOX || 'https://apis-sandbox.fedex.com';
    }
    if (provider === 'ups') {
        if (isProd) return process.env.UPS_BASE_URL_PROD || 'https://onlinetools.ups.com';
        return process.env.UPS_BASE_URL_SANDBOX || 'https://wwwcie.ups.com';
    }
    if (provider === 'dhl') {
        if (isProd) return process.env.DHL_BASE_URL_PROD || 'https://express.api.dhl.com/mydhlapi';
        return process.env.DHL_BASE_URL_SANDBOX || 'https://api-mock.dhl.com/mydhlapi';
    }
    return '';
}

async function getFedExToken(env, clientId, clientSecret) {
    const cacheKey = `fedex:${env}:${clientId}`;
    const now = Date.now();
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > now + 60 * 1000) return cached.token;

    const baseUrl = getBaseUrl('fedex', env);
    const form = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
    });
    const data = await fetchJson(`${baseUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
    });
    const token = data.access_token;
    const expiresIn = Math.max(300, asNumber(data.expires_in, 3600));
    if (!token) throw new Error('FedEx OAuth token 獲取失敗');

    tokenCache.set(cacheKey, { token, expiresAt: now + expiresIn * 1000 });
    return token;
}

async function quoteFedEx(ctx) {
    const clientId = process.env.FEDEX_CLIENT_ID;
    const clientSecret = process.env.FEDEX_CLIENT_SECRET;
    const accountNumber = process.env.FEDEX_ACCOUNT_NUMBER;
    if (!clientId || !clientSecret || !accountNumber) {
        throw new Error('缺少 FEDEX_CLIENT_ID / FEDEX_CLIENT_SECRET / FEDEX_ACCOUNT_NUMBER');
    }

    const baseUrl = getBaseUrl('fedex', ctx.environment);
    const token = await getFedExToken(ctx.environment, clientId, clientSecret);
    const pkg = resolveChargeableWeight(ctx.shipment.package);

    const payload = {
        accountNumber: { value: accountNumber },
        requestedShipment: {
            shipper: {
                address: {
                    city: ctx.shipment.origin.city || undefined,
                    postalCode: ctx.shipment.origin.postalCode,
                    countryCode: ctx.shipment.origin.countryCode,
                    residential: false
                }
            },
            recipient: {
                address: {
                    city: ctx.shipment.destination.city || undefined,
                    postalCode: ctx.shipment.destination.postalCode,
                    countryCode: ctx.shipment.destination.countryCode,
                    residential: false
                }
            },
            pickupType: 'DROPOFF_AT_FEDEX_LOCATION',
            packagingType: 'YOUR_PACKAGING',
            rateRequestType: ['ACCOUNT', 'LIST'],
            requestedPackageLineItems: [{
                weight: {
                    units: 'KG',
                    value: pkg.chargeableWeightKg
                },
                dimensions: (pkg.lengthCm > 0 && pkg.widthCm > 0 && pkg.heightCm > 0) ? {
                    units: 'CM',
                    length: Math.round(pkg.lengthCm),
                    width: Math.round(pkg.widthCm),
                    height: Math.round(pkg.heightCm)
                } : undefined
            }]
        }
    };

    const data = await fetchJson(`${baseUrl}/rate/v1/rates/quotes`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
    });

    const details = Array.isArray(data?.output?.rateReplyDetails) ? data.output.rateReplyDetails : [];
    const quotes = details.map(item => {
        const rated = Array.isArray(item?.ratedShipmentDetails) ? item.ratedShipmentDetails[0] : null;
        const charge = rated?.totalNetCharge || rated?.shipmentRateDetail?.totalNetCharge || rated?.totalBaseCharge || {};
        const amount = asNumber(charge.amount ?? charge.value, NaN);
        const currency = String(charge.currency || charge.currencyCode || 'USD').toUpperCase();
        const service = item?.serviceName || item?.serviceType || 'FEDEX_SERVICE';
        const transitDays = parseTransitDays(
            item?.commit?.transitDays ||
            item?.commit?.dateDetail?.dayOfWeek ||
            item?.operationalDetail?.deliveryDate ||
            item?.transitTime,
            5
        );
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return {
            provider: 'fedex',
            service,
            amount: roundTo(amount, 6),
            currency,
            transitDays
        };
    }).filter(Boolean);

    if (quotes.length === 0) throw new Error('FedEx 未返回可用報價');
    return quotes;
}

async function getUpsToken(env, clientId, clientSecret) {
    const cacheKey = `ups:${env}:${clientId}`;
    const now = Date.now();
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAt > now + 60 * 1000) return cached.token;

    const baseUrl = getBaseUrl('ups', env);
    const tokenPath = process.env.UPS_TOKEN_PATH || '/security/v1/oauth/token';
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const data = await fetchJson(`${baseUrl}${tokenPath}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${auth}`
        },
        body: form.toString()
    });
    const token = data.access_token;
    const expiresIn = Math.max(300, asNumber(data.expires_in, 3600));
    if (!token) throw new Error('UPS OAuth token 獲取失敗');

    tokenCache.set(cacheKey, { token, expiresAt: now + expiresIn * 1000 });
    return token;
}

function mapUpsServiceCode(code) {
    const map = {
        '01': 'UPS Next Day Air',
        '02': 'UPS 2nd Day Air',
        '03': 'UPS Ground',
        '07': 'UPS Worldwide Express',
        '08': 'UPS Worldwide Expedited',
        '11': 'UPS Standard',
        '12': 'UPS 3 Day Select',
        '13': 'UPS Next Day Air Saver',
        '54': 'UPS Worldwide Express Plus',
        '65': 'UPS Worldwide Saver'
    };
    return map[code] || `UPS-${code || 'SERVICE'}`;
}

async function quoteUPS(ctx) {
    const clientId = process.env.UPS_CLIENT_ID;
    const clientSecret = process.env.UPS_CLIENT_SECRET;
    const accountNumber = process.env.UPS_ACCOUNT_NUMBER || '';
    if (!clientId || !clientSecret) {
        throw new Error('缺少 UPS_CLIENT_ID / UPS_CLIENT_SECRET');
    }

    const baseUrl = getBaseUrl('ups', ctx.environment);
    const token = await getUpsToken(ctx.environment, clientId, clientSecret);
    const ratePath = process.env.UPS_RATE_PATH || '/api/rating/v2409/Rate';
    const pkg = resolveChargeableWeight(ctx.shipment.package);

    const payload = {
        RateRequest: {
            Request: {
                RequestOption: 'Shop'
            },
            Shipment: {
                Shipper: {
                    Name: 'Shipper',
                    ShipperNumber: accountNumber || undefined,
                    Address: {
                        City: ctx.shipment.origin.city || undefined,
                        PostalCode: ctx.shipment.origin.postalCode,
                        CountryCode: ctx.shipment.origin.countryCode
                    }
                },
                ShipTo: {
                    Address: {
                        City: ctx.shipment.destination.city || undefined,
                        PostalCode: ctx.shipment.destination.postalCode,
                        CountryCode: ctx.shipment.destination.countryCode
                    }
                },
                Package: [{
                    PackagingType: { Code: '02' },
                    Dimensions: (pkg.lengthCm > 0 && pkg.widthCm > 0 && pkg.heightCm > 0) ? {
                        UnitOfMeasurement: { Code: 'CM' },
                        Length: String(Math.round(pkg.lengthCm)),
                        Width: String(Math.round(pkg.widthCm)),
                        Height: String(Math.round(pkg.heightCm))
                    } : undefined,
                    PackageWeight: {
                        UnitOfMeasurement: { Code: 'KGS' },
                        Weight: String(pkg.chargeableWeightKg)
                    }
                }]
            }
        }
    };

    const data = await fetchJson(`${baseUrl}${ratePath}?requestoption=Shop`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            transId: `codex-${Date.now()}`,
            transactionSrc: 'ops-tool'
        },
        body: JSON.stringify(payload)
    });

    const ratedRaw = data?.RateResponse?.RatedShipment;
    const rated = Array.isArray(ratedRaw) ? ratedRaw : ratedRaw ? [ratedRaw] : [];
    const quotes = rated.map(item => {
        const charge = item?.TotalCharges || item?.NegotiatedRateCharges?.TotalCharge || {};
        const amount = asNumber(charge.MonetaryValue, NaN);
        const currency = String(charge.CurrencyCode || 'USD').toUpperCase();
        const serviceCode = String(item?.Service?.Code || '');
        const service = mapUpsServiceCode(serviceCode);
        const transitDays = parseTransitDays(
            item?.GuaranteedDelivery?.BusinessDaysInTransit ||
            item?.TimeInTransit?.ServiceSummary?.EstimatedArrival?.BusinessDaysInTransit,
            serviceCode === '03' ? 7 : 5
        );
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return {
            provider: 'ups',
            service,
            amount: roundTo(amount, 6),
            currency,
            transitDays
        };
    }).filter(Boolean);

    if (quotes.length === 0) throw new Error('UPS 未返回可用報價');
    return quotes;
}

async function quoteDHL(ctx) {
    const apiKey = process.env.DHL_API_KEY;
    const accountNumber = process.env.DHL_ACCOUNT_NUMBER || '';
    if (!apiKey) throw new Error('缺少 DHL_API_KEY');

    const baseUrl = getBaseUrl('dhl', ctx.environment);
    const pkg = resolveChargeableWeight(ctx.shipment.package);
    const payload = {
        customerDetails: {
            shipperDetails: {
                cityName: ctx.shipment.origin.city || undefined,
                postalCode: ctx.shipment.origin.postalCode,
                countryCode: ctx.shipment.origin.countryCode
            },
            receiverDetails: {
                cityName: ctx.shipment.destination.city || undefined,
                postalCode: ctx.shipment.destination.postalCode,
                countryCode: ctx.shipment.destination.countryCode
            }
        },
        accounts: accountNumber ? [{ typeCode: 'shipper', number: accountNumber }] : undefined,
        plannedShippingDateAndTime: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19) + ' GMT+00:00',
        unitOfMeasurement: 'metric',
        isCustomsDeclarable: true,
        packages: [{
            weight: pkg.chargeableWeightKg,
            dimensions: (pkg.lengthCm > 0 && pkg.widthCm > 0 && pkg.heightCm > 0) ? {
                length: Math.round(pkg.lengthCm),
                width: Math.round(pkg.widthCm),
                height: Math.round(pkg.heightCm)
            } : undefined
        }]
    };

    const data = await fetchJson(`${baseUrl}/rates`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'DHL-API-Key': apiKey
        },
        body: JSON.stringify(payload)
    });

    const products = Array.isArray(data?.products) ? data.products : [];
    const quotes = products.map(item => {
        const priceNode = Array.isArray(item?.totalPrice) ? item.totalPrice[0] : item?.totalPrice;
        const amount = asNumber(priceNode?.price, NaN);
        const currency = String(priceNode?.currencyType || priceNode?.currency || 'USD').toUpperCase();
        const service = item?.productName || item?.productCode || 'DHL_SERVICE';
        const transitDays = parseTransitDays(
            item?.deliveryCapabilities?.estimatedDeliveryDateAndTime ||
            item?.deliveryCapabilities?.totalTransitDays ||
            item?.deliveryCapabilities?.deliveryTypeCode,
            5
        );
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return {
            provider: 'dhl',
            service,
            amount: roundTo(amount, 6),
            currency,
            transitDays
        };
    }).filter(Boolean);

    if (quotes.length === 0) throw new Error('DHL 未返回可用報價');
    return quotes;
}

async function quoteByCustomEndpoint(kind, ctx) {
    const endpoint = process.env[`${kind.toUpperCase()}_RATE_ENDPOINT`];
    if (!endpoint) {
        const flatUsd = asNumber(process.env[`${kind.toUpperCase()}_FLAT_RATE_USD`], 0);
        const transitDays = asNumber(process.env[`${kind.toUpperCase()}_TRANSIT_DAYS`], 0);
        if (flatUsd > 0 && transitDays > 0) {
            return [{
                provider: kind,
                service: `${kind.toUpperCase()}_ESTIMATE`,
                amount: roundTo(flatUsd, 6),
                currency: 'USD',
                transitDays: Math.round(transitDays)
            }];
        }
        throw new Error(`未配置 ${kind.toUpperCase()}_RATE_ENDPOINT（可用 ${kind.toUpperCase()}_FLAT_RATE_USD 兜底）`);
    }

    const data = await fetchJson(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ctx)
    });

    const rawQuotes = Array.isArray(data?.quotes) ? data.quotes : [data];
    const quotes = rawQuotes.map(item => {
        const amount = asNumber(item?.amount, NaN);
        const currency = String(item?.currency || 'USD').toUpperCase();
        const service = String(item?.service || `${kind.toUpperCase()}_SERVICE`);
        const transitDays = parseTransitDays(item?.transitDays, kind === 'air' ? 9 : 32);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        return {
            provider: kind,
            service,
            amount: roundTo(amount, 6),
            currency,
            transitDays
        };
    }).filter(Boolean);

    if (quotes.length === 0) throw new Error(`${kind.toUpperCase()} 介面未返回可用報價`);
    return quotes;
}

async function maybeFetchFxRates(quotes) {
    const currencies = new Set(
        quotes
            .map(item => String(item.currency || '').toUpperCase())
            .filter(code => code && code !== 'USD')
    );
    if (currencies.size === 0) return {};

    try {
        const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
        const rates = data?.rates || {};
        const picked = {};
        currencies.forEach(code => {
            if (Number.isFinite(rates[code]) && rates[code] > 0) picked[code] = rates[code];
        });
        return picked;
    } catch (error) {
        return {};
    }
}

async function handleQuoteRequest(payload) {
    const environment = payload?.environment === 'production' ? 'production' : 'sandbox';
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    if (providers.length === 0) throw new Error('providers 不能為空');

    const shipment = payload?.shipment || {};
    const origin = shipment.origin || {};
    const destination = shipment.destination || {};
    const pkg = shipment.package || {};
    if (!origin.countryCode || !origin.postalCode || !destination.countryCode || !destination.postalCode) {
        throw new Error('origin/destination 國家和郵編不能為空');
    }
    if (asNumber(pkg.actualWeightKg, 0) <= 0) throw new Error('actualWeightKg 必須大於 0');

    const ctx = {
        environment,
        providers,
        shipment: {
            origin: {
                countryCode: String(origin.countryCode).trim().toUpperCase(),
                city: String(origin.city || '').trim(),
                postalCode: String(origin.postalCode).trim()
            },
            destination: {
                countryCode: String(destination.countryCode).trim().toUpperCase(),
                city: String(destination.city || '').trim(),
                postalCode: String(destination.postalCode).trim()
            },
            package: {
                actualWeightKg: asNumber(pkg.actualWeightKg, 0),
                lengthCm: asNumber(pkg.lengthCm, 0),
                widthCm: asNumber(pkg.widthCm, 0),
                heightCm: asNumber(pkg.heightCm, 0),
                volumetricWeightKg: asNumber(pkg.volumetricWeightKg, 0),
                chargeableWeightKg: asNumber(pkg.chargeableWeightKg, 0),
                volumetricDivisor: asNumber(pkg.volumetricDivisor, 5000)
            }
        }
    };

    const providerHandlers = {
        dhl: quoteDHL,
        ups: quoteUPS,
        fedex: quoteFedEx,
        air: (data) => quoteByCustomEndpoint('air', data),
        sea: (data) => quoteByCustomEndpoint('sea', data)
    };

    const tasks = providers.map(async providerRaw => {
        const provider = String(providerRaw || '').toLowerCase();
        const handler = providerHandlers[provider];
        if (!handler) {
            return { provider, quotes: [], error: `不支援的 provider: ${provider}` };
        }
        try {
            const quotes = await handler(ctx);
            return { provider, quotes, error: '' };
        } catch (error) {
            return { provider, quotes: [], error: error.message || 'unknown error' };
        }
    });

    const results = await Promise.all(tasks);
    const quotes = [];
    const errors = [];
    results.forEach(item => {
        if (Array.isArray(item.quotes) && item.quotes.length > 0) {
            quotes.push(...item.quotes);
        } else if (item.error) {
            errors.push({ provider: item.provider, message: item.error });
        }
    });

    const weightInfo = resolveChargeableWeight(ctx.shipment.package);
    const fxRates = await maybeFetchFxRates(quotes);
    return {
        quotes,
        errors,
        fxRates,
        meta: {
            environment,
            actualWeightKg: weightInfo.actualWeightKg,
            volumetricWeightKg: weightInfo.volumetricWeightKg,
            chargeableWeightKg: weightInfo.chargeableWeightKg,
            isBulky: weightInfo.isBulky
        }
    };
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        sendJson(res, 204, {});
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, time: new Date().toISOString() });
        return;
    }

    if (req.method === 'GET' && url.pathname === '/api/shipping/providers') {
        sendJson(res, 200, {
            providers: {
                dhl: !!process.env.DHL_API_KEY,
                ups: !!(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET),
                fedex: !!(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET && process.env.FEDEX_ACCOUNT_NUMBER),
                air: !!(process.env.AIR_RATE_ENDPOINT || process.env.AIR_FLAT_RATE_USD),
                sea: !!(process.env.SEA_RATE_ENDPOINT || process.env.SEA_FLAT_RATE_USD)
            }
        });
        return;
    }

    if (req.method === 'POST' && url.pathname === '/api/shipping/quotes') {
        try {
            const payload = await readJsonBody(req);
            const result = await handleQuoteRequest(payload);
            sendJson(res, 200, result);
        } catch (error) {
            sendJson(res, 400, {
                message: error.message || '請求失敗',
                detail: error.data || undefined
            });
        }
        return;
    }

    sendJson(res, 404, { message: 'Not Found' });
});

server.listen(PORT, HOST, () => {
    process.stdout.write(`[shipping-quote-proxy] listening on http://${HOST}:${PORT}\n`);
});

