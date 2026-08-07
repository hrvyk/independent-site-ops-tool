# 即時物流報價代理（DHL / UPS / FedEx / 空派 / 海派）

## 1) 啟動方式

```bash
cd /Users/HarveyKeitel/Downloads/src
node shipping_quote_proxy.js
```

預設地址：`http://127.0.0.1:8787`

可用健康檢查：

```bash
curl -s http://127.0.0.1:8787/health
```

## 2) 必要環境變數

### DHL

- `DHL_API_KEY`
- `DHL_ACCOUNT_NUMBER`（可選，建議填）
- `DHL_BASE_URL_SANDBOX`（可選，預設 `https://api-mock.dhl.com/mydhlapi`）
- `DHL_BASE_URL_PROD`（可選，預設 `https://express.api.dhl.com/mydhlapi`）

### UPS

- `UPS_CLIENT_ID`
- `UPS_CLIENT_SECRET`
- `UPS_ACCOUNT_NUMBER`（可選）
- `UPS_BASE_URL_SANDBOX`（可選，預設 `https://wwwcie.ups.com`）
- `UPS_BASE_URL_PROD`（可選，預設 `https://onlinetools.ups.com`）
- `UPS_TOKEN_PATH`（可選，預設 `/security/v1/oauth/token`）
- `UPS_RATE_PATH`（可選，預設 `/api/rating/v2409/Rate`）

### FedEx

- `FEDEX_CLIENT_ID`
- `FEDEX_CLIENT_SECRET`
- `FEDEX_ACCOUNT_NUMBER`
- `FEDEX_BASE_URL_SANDBOX`（可選，預設 `https://apis-sandbox.fedex.com`）
- `FEDEX_BASE_URL_PROD`（可選，預設 `https://apis.fedex.com`）

### 空派/海派（無 Freightos key 的替代方式）

你當前沒有 Freightos / 貨代 API key，可以先二選一：

1. 配置你已有貨代介面：  
`AIR_RATE_ENDPOINT`、`SEA_RATE_ENDPOINT`
2. 臨時配置固定價兜底：  
`AIR_FLAT_RATE_USD`、`AIR_TRANSIT_DAYS`、`SEA_FLAT_RATE_USD`、`SEA_TRANSIT_DAYS`

## 3) 拋貨與計費重規則（已內建）

- 體積重：`L*W*H/5000`（cm/kg）
- 拋貨判定：`體積重 > 實重 * 1.15`
- 計費重：`max(實重, 體積重)`（預設按計費重）

## 4) 前端填寫建議（預設值）

- 發貨地：`CN / Shanghai / 200000`
- 目的地：按客戶地址填寫國家程式碼 + 郵編
- 重量：填實重（kg）
- 長寬高：有就填，系統自動判斷拋貨並算計費重

