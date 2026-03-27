(function(root, factory) {
  const exported = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.mailtrackOpenHelpers = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const OPEN_TIMESTAMP_FIELDS = ['opened_at', 'open_time', 'timestamp', 'created_at', 'time'];

  function normalizeOpenTimestamp(value) {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) {
      return numericValue > 1e12 ? numericValue / 1000 : numericValue;
    }

    const parsedValue = Date.parse(value);
    if (Number.isNaN(parsedValue)) {
      return null;
    }

    return parsedValue / 1000;
  }

  function hashString(value) {
    let hash = 2166136261;

    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return (hash >>> 0).toString(16);
  }

  function getOpenTimestamp(open) {
    for (const field of OPEN_TIMESTAMP_FIELDS) {
      const parsedTimestamp = normalizeOpenTimestamp(open?.[field]);
      if (parsedTimestamp !== null) {
        return parsedTimestamp;
      }
    }

    return null;
  }

  function getFallbackOpenFingerprint(open) {
    const fingerprintEntries = Object.entries(open || {})
      .filter(([field, value]) => (
        field !== 'open_id' &&
        !OPEN_TIMESTAMP_FIELDS.includes(field) &&
        value !== undefined &&
        value !== null &&
        value !== ''
      ))
      .map(([field, value]) => [field, String(value)]);
    const timestamp = getOpenTimestamp(open);

    if (timestamp !== null) {
      fingerprintEntries.push(['normalized_timestamp', String(timestamp)]);
    }

    fingerprintEntries.sort(([left], [right]) => left.localeCompare(right));

    return hashString(
      fingerprintEntries.map(([field, value]) => `${field}:${value}`).join('|') || 'unknown-open'
    );
  }

  function getOpenIdentity(open) {
    const openId = open?.open_id;
    if (openId !== undefined && openId !== null && openId !== '') {
      const key = String(openId);
      return {
        dedupeKey: key,
        notificationId: `open-${key}`
      };
    }

    const fingerprint = getFallbackOpenFingerprint(open);
    return {
      dedupeKey: `fingerprint:${fingerprint}`,
      notificationId: `open-fallback-${fingerprint}`
    };
  }

  function getLatestOpenTimestamp(opens, since) {
    return opens.reduce((latest, open) => {
      const openTimestamp = getOpenTimestamp(open);
      if (openTimestamp !== null) {
        return Math.max(latest, openTimestamp);
      }

      return latest;
    }, since);
  }

  return {
    OPEN_TIMESTAMP_FIELDS,
    normalizeOpenTimestamp,
    hashString,
    getOpenTimestamp,
    getFallbackOpenFingerprint,
    getOpenIdentity,
    getLatestOpenTimestamp
  };
});
