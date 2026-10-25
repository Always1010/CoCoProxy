/** Reviewed AlwayRoute service catalog; UI order differs from match priority. */
export const serviceCatalog = [
  {
    "id": "Proxy",
    "name": "代理",
    "default": true,
    "description": "业务组、国外代理与 Other 可跟随的公共代理出口",
    "domains": [],
    "exactDomains": []
  },
  {
    "id": "Overseas",
    "name": "国外代理",
    "default": true,
    "description": "常用境外网站与固定境外域名库；专用业务规则优先，初始跟随 Proxy。",
    "domains": [
      "github.com",
      "githubassets.com",
      "githubusercontent.com",
      "github.io",
      "netflix.com",
      "nflxext.com",
      "nflximg.com",
      "nflxso.net",
      "nflxvideo.net",
      "disneyplus.com",
      "disney-plus.net",
      "dssott.com",
      "spotify.com",
      "scdn.co",
      "reddit.com",
      "redd.it",
      "wikipedia.org",
      "wikimedia.org",
      "twitch.tv",
      "medium.com",
      "stackoverflow.com"
    ],
    "exactDomains": []
  },
  {
    "id": "OpenAI",
    "name": "OpenAI",
    "default": true,
    "description": "OpenAI、ChatGPT 及静态内容",
    "domains": [
      "openai.com",
      "chatgpt.com",
      "oaistatic.com",
      "oaiusercontent.com"
    ],
    "exactDomains": []
  },
  {
    "id": "Claude",
    "name": "Claude",
    "default": true,
    "description": "Anthropic 与 Claude",
    "domains": [
      "anthropic.com",
      "claude.ai",
      "claude.com"
    ],
    "exactDomains": []
  },
  {
    "id": "Google",
    "name": "Google",
    "default": true,
    "description": "Google 通用服务；YouTube 规则优先",
    "domains": [
      "google.com",
      "googleapis.com",
      "gstatic.com",
      "googleusercontent.com",
      "googleadservices.com",
      "google-analytics.com",
      "withgoogle.com",
      "blogger.com",
      "blogspot.com"
    ],
    "exactDomains": []
  },
  {
    "id": "YouTube",
    "name": "YouTube",
    "default": true,
    "description": "YouTube 页面、短链、视频与静态内容",
    "domains": [
      "youtube.com",
      "youtu.be",
      "youtube-nocookie.com",
      "googlevideo.com",
      "ytimg.com",
      "ggpht.com",
      "ggpht.cn"
    ],
    "exactDomains": [
      "yt3.googleusercontent.com",
      "youtubei.googleapis.com"
    ]
  },
  {
    "id": "TikTok",
    "name": "TikTok",
    "default": true,
    "description": "TikTok 专用域名、CDN 和经采样确认的关联主机；初始跟随 Proxy。",
    "domains": [
      "bytedapm.com",
      "muscdn.com",
      "musical.ly",
      "tik-tokapi.com",
      "tiktok-minis.com",
      "tiktok-row.net",
      "tiktok.com",
      "tiktokcdn-eu.com",
      "tiktokcdn-us.com",
      "tiktokcdn.com",
      "tiktokd.net",
      "tiktokd.org",
      "tiktokeu-cdn.com",
      "tiktokglobalshopv.com",
      "tiktokminis.us",
      "tiktokrow-cdn.com",
      "tiktokv.com",
      "tiktokv.eu",
      "tiktokv.us",
      "tiktokw.eu",
      "tiktokw.us",
      "ttcdn-us.com",
      "ttlivecdn.com",
      "ttoverseaus.net",
      "ttwstatic.com",
      "tiktokcdn-us.com.edgesuite.net",
      "tiktokcdn.com.akamaized.net",
      "tiktokcdn.com.edgesuite.net",
      "tiktokv.com.edgekey.net",
      "tiktokv.com.edgesuite.net"
    ],
    "exactDomains": [
      "p16-tiktokcdn-com.akamaized.net",
      "p16-tiktok-dm-sticker-sign-sg.ibyteimg.com",
      "roovza-launches.appsflyersdk.com",
      "roovza.inapps.appsflyersdk.com",
      "roovza.launches.appsflyersdk.com",
      "roovza.skadsdk.appsflyersdk.com",
      "p19-oec-va.ibyteimg.com",
      "roovza.cdn-settings.appsflyersdk.com"
    ]
  },
  {
    "id": "X",
    "name": "X",
    "default": true,
    "description": "X（原 Twitter）页面、短链与静态内容",
    "domains": [
      "x.com",
      "twitter.com",
      "t.co",
      "twimg.com"
    ],
    "exactDomains": []
  },
  {
    "id": "Telegram",
    "name": "Telegram",
    "default": true,
    "description": "Telegram 官方网页与公开链接",
    "domains": [
      "telegram.org",
      "telegram.me",
      "telegram.dog",
      "t.me",
      "telesco.pe",
      "telegra.ph"
    ],
    "exactDomains": []
  },
  {
    "id": "Domestic",
    "name": "国内直连",
    "default": true,
    "description": "国内社区域名库与国家顶级域补充；明确业务规则优先。",
    "domains": [
      "cn"
    ],
    "exactDomains": []
  },
  {
    "id": "Other",
    "name": "Other",
    "default": true,
    "description": "所有规则均未命中时的最终出口",
    "domains": [],
    "exactDomains": []
  },
  {
    "id": "Microsoft",
    "name": "Microsoft",
    "default": false,
    "description": "Microsoft、Microsoft 365 与常用消费服务",
    "domains": [
      "microsoft.com",
      "microsoftonline.com",
      "live.com",
      "office.com",
      "office365.com",
      "outlook.com",
      "windows.com",
      "azure.com",
      "bing.com",
      "xbox.com",
      "cloud.microsoft",
      "static.microsoft",
      "usercontent.microsoft"
    ],
    "exactDomains": []
  },
  {
    "id": "Apple",
    "name": "Apple",
    "default": false,
    "description": "Apple、iCloud、商店与静态内容",
    "domains": [
      "apple.com",
      "icloud.com",
      "icloud-content.com",
      "itunes.apple.com",
      "apps.apple.com",
      "mzstatic.com",
      "cdn-apple.com",
      "apple-dns.net"
    ],
    "exactDomains": []
  },
  {
    "id": "Meta",
    "name": "Meta",
    "default": false,
    "description": "Meta、Facebook、Instagram 与 WhatsApp",
    "domains": [
      "meta.com",
      "facebook.com",
      "fb.com",
      "fbcdn.net",
      "instagram.com",
      "cdninstagram.com",
      "whatsapp.com",
      "whatsapp.net"
    ],
    "exactDomains": []
  },
  {
    "id": "Discord",
    "name": "Discord",
    "default": false,
    "description": "Discord 页面、API 与内容分发",
    "domains": [
      "discord.com",
      "discord.gg",
      "discordapp.com",
      "discordapp.net"
    ],
    "exactDomains": []
  },
  {
    "id": "Steam",
    "name": "Steam",
    "default": false,
    "description": "Steam 商店、社区、内容与 API",
    "domains": [
      "steampowered.com",
      "steamcommunity.com",
      "steamstatic.com",
      "steamcontent.com",
      "steamserver.net",
      "steam-api.com",
      "valvesoftware.com"
    ],
    "exactDomains": []
  }
] as const;
