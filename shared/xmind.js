// .xmind 格式判定唯一出处：预览页与离线冒烟共用，不写第二份判定。
// 对应档案 §0.4「预览实现路线」、§0.6「两代 .xmind 格式解析」：
//   现代 XMind（Zen / 2020+）主体在 content.json；
//   XMind 8 及以前在 content.xml；
//   新版文件里也可能带一个只提示升级的占位 content.xml，只读它会得到空图。
// 铁律：有 content.json 一律优先，绝不先读 XML。

const utf8 = new TextDecoder();

function asText(bytes) {
  try {
    return utf8.decode(bytes);
  } catch {
    return '';
  }
}

/**
 * @param {Record<string, Uint8Array>} entries 已解压的 ZIP 条目（fflate unzipSync 结果）
 * @returns {{ ok: boolean, format: string, label?: string, reason?: string }}
 */
export function inspectXmind(entries) {
  const hasJson = Boolean(entries['content.json']);
  const hasXml = Boolean(entries['content.xml']);

  if (hasJson) {
    // 即使同时存在占位 content.xml，也走 JSON（避免空图）
    return { ok: true, format: 'json', label: 'XMind 2020+（content.json）' };
  }
  if (!hasXml) {
    return {
      ok: false,
      format: 'unknown',
      reason: '包内没有 content.json / content.xml，可能不是 XMind 文件或版本过新',
    };
  }

  const xml = asText(entries['content.xml']);
  const hasRealTopics = /<topic\b/i.test(xml);
  const looksLikeUpgradeNotice =
    /upgrade|升级|newer version|please update|更高版本/i.test(xml);

  // 新版占位 XML：短小、只有一句升级提示，交给库解析会得到空图
  if (!hasRealTopics || (looksLikeUpgradeNotice && xml.length < 8000)) {
    return {
      ok: false,
      format: 'xml-placeholder',
      reason: '只找到「请升级」占位的 content.xml，没有可读导图数据',
    };
  }
  return { ok: true, format: 'xml', label: 'XMind 8 及以前（content.xml）' };
}
