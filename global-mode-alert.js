/**
 * 代理模式提醒 for Shadowrocket
 *
 * 探针 A：myip.ipip.net（模块规则 DIRECT）
 * 探针 B：www.cloudflare.com/cdn-cgi/trace（模块规则 PROXY）
 *
 *   配置模式：A=中国  B=境外   → 正常，不提醒
 *   全局模式：A=境外  B=境外   → 规则被忽略，DIRECT 也走了节点
 *   直连模式：A=中国  B=中国   → 规则被忽略，PROXY 也走了直连
 *
 * argument:
 *   interval=提醒间隔(分钟)，默认 30
 *   global=1/0  是否提醒全局模式，默认 1
 *   direct=1/0  是否提醒直连模式，默认 1
 */

const KEY_STATE = "pma_state";
const KEY_TS = "pma_last_notify";

function parseArgs(str) {
  const out = {};
  if (typeof str !== "string") return out;
  str.split("&").forEach(kv => {
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim()] = decodeURIComponent(kv.slice(i + 1).trim());
  });
  return out;
}

const args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
const intervalMs = (Number(args.interval) || 30) * 60 * 1000;
const alertGlobal = args.global !== "0";
const alertDirect = args.direct !== "0";

function get(url) {
  return new Promise(resolve => {
    $httpClient.get({ url, timeout: 10 }, (err, resp, data) => {
      resolve(err || !data ? null : data);
    });
  });
}

// 探针 A：DIRECT 出口是否在中国
async function probeDirect() {
  const data = await get("https://myip.ipip.net/json");
  if (!data) return null;
  try {
    const d = JSON.parse(data).data;
    const loc = d.location || [];
    return { cn: loc[0] === "中国", ip: d.ip, where: loc.filter(Boolean).slice(0, 3).join(" ") };
  } catch (e) {
    return null;
  }
}

// 探针 B：PROXY 出口是否在中国
async function probeProxy() {
  const data = await get("https://www.cloudflare.com/cdn-cgi/trace");
  if (!data) return null;
  const kv = {};
  data.split("\n").forEach(l => {
    const i = l.indexOf("=");
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim();
  });
  if (!kv.loc) return null;
  return { cn: kv.loc === "CN", ip: kv.ip, where: kv.loc };
}

function notify(mode, a, b) {
  if (mode === "global") {
    $notification.post(
      "⚠️ 全局代理还开着",
      `国内流量也在走节点 · 出口 ${a.where}`,
      `${a.ip}\n不需要的话记得切回「配置」模式`
    );
  } else if (mode === "direct") {
    $notification.post(
      "⚠️ 当前是直连模式",
      "代理规则没有生效，所有流量都在直连",
      `出口 ${b.ip}\n需要翻墙的话记得切回「配置」模式`
    );
  }
}

(async () => {
  const [a, b] = await Promise.all([probeDirect(), probeProxy()]);

  // 判定：只用拿到结果的探针，拿不到就不下结论，避免误报
  let mode = "rule";
  if (a && !a.cn) mode = "global";
  else if (b && b.cn) mode = "direct";
  else if (!a && !b) return $done();

  const enabled = (mode === "global" && alertGlobal) || (mode === "direct" && alertDirect);
  const now = Date.now();
  const lastState = $persistentStore.read(KEY_STATE);
  const lastTs = Number($persistentStore.read(KEY_TS) || 0);

  if (mode === "rule") {
    $persistentStore.write("0", KEY_TS);
  } else if (enabled && (lastState !== mode || now - lastTs > intervalMs)) {
    notify(mode, a, b);
    $persistentStore.write(String(now), KEY_TS);
  }
  $persistentStore.write(mode, KEY_STATE);
  $done();
})().catch(() => $done());
