/**
 * 代理模式提醒 for Shadowrocket
 *
 * 探针 A：cloudflare.com/cdn-cgi/trace（模块规则 DIRECT），失败时回退 myip.ipip.net
 * 探针 B：www.cloudflare.com/cdn-cgi/trace（模块规则 PROXY）
 *
 *   配置模式：A=中国  B=境外   → 正常，不提醒
 *   全局模式：A=境外  B=境外   → 规则被忽略，DIRECT 也走了节点
 *   直连模式：A=中国  B=中国   → 规则被忽略，PROXY 也走了直连
 *
 * argument:
 *   interval=提醒间隔(分钟)，默认 1（持续处于全局/直连时每分钟提醒）
 *   global=1/0  是否提醒全局模式，默认 1
 *   direct=1/0  是否提醒直连模式，默认 1
 *   debug=1/0   调试模式：每次运行都通知判定结果和两个探针的原始数据，默认 0
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
// 留 10 秒余量，避免 cron 每分钟触发时因执行耗时差几秒而被跳过
const intervalMs = Math.max((Number(args.interval) || 1) * 60 * 1000 - 10 * 1000, 0);
const alertGlobal = args.global !== "0";
const alertDirect = args.direct !== "0";
const debug = args.debug === "1";

function get(url) {
  return new Promise(resolve => {
    $httpClient.get({ url, timeout: 10 }, (err, resp, data) => {
      resolve(err || !data ? null : data);
    });
  });
}

function parseTrace(data) {
  if (!data) return null;
  const kv = {};
  data.split("\n").forEach(l => {
    const i = l.indexOf("=");
    if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1).trim();
  });
  if (!kv.loc) return null;
  return { cn: kv.loc === "CN", ip: kv.ip, where: kv.loc };
}

// 探针 A：DIRECT 出口是否在中国
// 优先用 Cloudflare 根域名（与探针 B 同源同格式），失败再回退 ipip.net
// （ipip.net 对境外/机房 IP 经常拒绝服务，全局模式下会请求失败）
async function probeDirect() {
  const cf = parseTrace(await get("https://cloudflare.com/cdn-cgi/trace"));
  if (cf) return cf;
  const data = await get("https://myip.ipip.net/json");
  if (!data) return null;
  try {
    const d = JSON.parse(data).data;
    const loc = d.location || [];
    if (!loc[0]) return null;
    return { cn: loc[0] === "中国", ip: d.ip, where: loc.filter(Boolean).slice(0, 3).join(" ") };
  } catch (e) {
    return null;
  }
}

// 探针 B：PROXY 出口是否在中国
async function probeProxy() {
  return parseTrace(await get("https://www.cloudflare.com/cdn-cgi/trace"));
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

  // 判定：探针 A 境外 → 全局；探针 B 国内 → 直连；
  // 只有两个探针都成功且 A 国内、B 境外才判定为配置模式，缺任何一个都不下结论
  let mode = "unknown";
  if (a && !a.cn) mode = "global";
  else if (b && b.cn) mode = "direct";
  else if (a && b) mode = "rule";

  if (debug) {
    const fmt = p => (p ? `${p.cn ? "CN" : "非CN"} ${p.where} ${p.ip}` : "请求失败");
    const names = { rule: "配置", global: "全局", direct: "直连", unknown: "无法判定" };
    const msg = `探针A(DIRECT): ${fmt(a)}\n探针B(PROXY): ${fmt(b)}`;
    console.log(`[代理模式提醒] 判定=${mode}\n${msg}`);
    $notification.post(`🐞 调试：判定为「${names[mode]}」`, "", msg);
  }

  if (mode === "unknown") return $done();

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
