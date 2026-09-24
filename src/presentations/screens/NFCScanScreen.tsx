import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import NfcManager, { Ndef, NfcError, NfcTech, TagEvent, NdefRecord } from 'react-native-nfc-manager';

// ---------------------------------------------------------------------------
// Warna & tipe
// ---------------------------------------------------------------------------

const C = {
  bg: '#EEF2F0',
  surface: '#FFFFFF',
  ink: '#1D2B2A',
  muted: '#5E6E6C',
  line: '#D5DDDA',
  signal: '#0A7F6F', // berhasil
  scan: '#2E4FD8', // sedang memindai
  danger: '#B3362E',
};

type Status = 'checking' | 'unsupported' | 'disabled' | 'ready' | 'scanning' | 'success' | 'error';

type ParsedRecord = {
  kind: string;
  value: string;
  detail?: string;
};

type ScanResult = {
  id: string;
  techTypes: string[];
  records: ParsedRecord[];
  raw: TagEvent;
  scannedAt: Date;
};

// ---------------------------------------------------------------------------
// Helper untuk mengurai data NDEF
// ---------------------------------------------------------------------------

function utf8(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b >= 0xc0 && b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b >= 0xe0 && b < 0xf0) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      const cp =
        ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
}

function typeToString(type: NdefRecord['type']): string {
  if (typeof type === 'string') return type;
  return String.fromCharCode(...Array.from(type ?? []));
}

function parseRecord(record: NdefRecord): ParsedRecord {
  const payload = Array.from(record.payload ?? []) as number[];
  const type = typeToString(record.type);

  try {
    if (record.tnf === Ndef.TNF_WELL_KNOWN && type === 'T') {
      const langLength = payload[0] & 0x3f;
      const lang = utf8(payload.slice(1, 1 + langLength));
      return { kind: 'Teks', value: Ndef.text.decodePayload(Uint8Array.from(payload)), detail: `Bahasa: ${lang}` };
    }
    if (record.tnf === Ndef.TNF_WELL_KNOWN && type === 'U') {
      return { kind: 'Tautan', value: Ndef.uri.decodePayload(Uint8Array.from(payload)) };
    }
    if (record.tnf === Ndef.TNF_MIME_MEDIA) {
      const readable = type.startsWith('text/') || type.includes('json') || type.includes('xml');
      return { kind: 'MIME', value: readable ? utf8(payload) : toHex(payload), detail: type };
    }
    if (record.tnf === Ndef.TNF_ABSOLUTE_URI) {
      return { kind: 'Tautan', value: type };
    }
    if (record.tnf === Ndef.TNF_EXTERNAL_TYPE) {
      return { kind: 'Tipe eksternal', value: utf8(payload), detail: type };
    }
  } catch {
    // Jatuh ke tampilan data mentah di bawah
  }

  return {
    kind: 'Data mentah',
    value: payload.length ? toHex(payload) : '(kosong)',
    detail: type ? `Tipe: ${type}` : undefined,
  };
}

function toResult(tag: TagEvent): ScanResult {
  return {
    id: tag.id ? String(tag.id).toUpperCase() : 'Tidak tersedia',
    techTypes: (tag.techTypes ?? []).map((t) => t.split('.').pop() ?? t),
    records: (tag.ndefMessage ?? []).map(parseRecord),
    raw: tag,
    scannedAt: new Date(),
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return 'Tag tidak terbaca. Tahan tag lebih lama di belakang ponsel, lalu coba lagi.';
}

const STATUS_COPY: Record<Status, { title: string; body: string }> = {
  checking: { title: 'Memeriksa NFC', body: 'Sebentar, sedang memeriksa perangkat.' },
  unsupported: { title: 'NFC tidak tersedia', body: 'Perangkat ini tidak memiliki NFC, jadi tag tidak bisa dibaca.' },
  disabled: { title: 'NFC mati', body: 'Nyalakan NFC di pengaturan ponsel, lalu kembali ke sini.' },
  ready: { title: 'Siap membaca', body: 'Tekan tombol di bawah, lalu dekatkan tag ke belakang ponsel.' },
  scanning: { title: 'Dekatkan tag', body: 'Tempelkan tag ke belakang ponsel dan tahan sampai terbaca.' },
  success: { title: 'Tag terbaca', body: 'Isi tag ditampilkan di bawah.' },
  error: { title: 'Gagal membaca', body: '' },
};

// ---------------------------------------------------------------------------
// Komponen
// ---------------------------------------------------------------------------

export default function NfcReaderScreen() {
  const [status, setStatus] = useState<Status>('checking');
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<ScanResult | null>(null);
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  const mounted = useRef(true);
  const cancelled = useRef(false);
  const pulse = useRef(new Animated.Value(0)).current;

  const refreshEnabled = useCallback(async () => {
    try {
      const enabled = await NfcManager.isEnabled();
      if (!mounted.current) return;
      setStatus((prev) => {
        if (prev === 'scanning' || prev === 'success' || prev === 'error') return prev;
        return enabled ? 'ready' : 'disabled';
      });
    } catch {
      if (mounted.current) setStatus('disabled');
    }
  }, []);

  // Inisialisasi NFC & pantau saat pengguna kembali dari Pengaturan
  useEffect(() => {
    mounted.current = true;

    (async () => {
      const supported = await NfcManager.isSupported();
      if (!supported) {
        if (mounted.current) setStatus('unsupported');
        return;
      }
      await NfcManager.start();
      await refreshEnabled();
    })();

    AccessibilityInfo.isReduceMotionEnabled().then((v) => mounted.current && setReduceMotion(v));
    const motionSub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refreshEnabled();
    });

    return () => {
      mounted.current = false;
      motionSub.remove();
      appSub.remove();
      NfcManager.cancelTechnologyRequest().catch(() => {});
    };
  }, [refreshEnabled]);

  // Animasi gelombang hanya saat memindai
  useEffect(() => {
    if (status !== 'scanning' || reduceMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, { toValue: 1, duration: 1600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [status, reduceMotion, pulse]);

  const scan = useCallback(async () => {
    setError(null);
    setShowRaw(false);
    setStatus('scanning');
    cancelled.current = false;

    try {
      await NfcManager.requestTechnology(NfcTech.Ndef, {
        alertMessage: 'Dekatkan tag NFC ke bagian atas iPhone',
      });
      const tag = await NfcManager.getTag();
      if (!tag) throw new Error('Tag tidak terbaca. Tahan tag lebih lama, lalu coba lagi.');

      const result = toResult(tag);
      if (Platform.OS === 'ios') await NfcManager.setAlertMessageIOS('Tag terbaca');
      if (!mounted.current) return;

      setCurrent(result);
      setHistory((h) => [result, ...h].slice(0, 10));
      setStatus('success');
    } catch (e) {
      if (!mounted.current) return;
      if (cancelled.current || e instanceof NfcError.UserCancel) {
        setStatus('ready');
      } else {
        setError(errorMessage(e));
        setStatus('error');
      }
    } finally {
      NfcManager.cancelTechnologyRequest().catch(() => {});
    }
  }, []);

  const cancelScan = useCallback(() => {
    cancelled.current = true;
    NfcManager.cancelTechnologyRequest().catch(() => {});
  }, []);

  const openSettings = useCallback(() => {
    NfcManager.goToNfcSetting().catch(() => {});
  }, []);

  // Tombol utama berubah sesuai status
  const primary = (() => {
    switch (status) {
      case 'scanning':
        return { label: 'Batalkan', onPress: cancelScan, tone: 'outline' as const };
      case 'disabled':
        return Platform.OS === 'android'
          ? { label: 'Buka pengaturan NFC', onPress: openSettings, tone: 'solid' as const }
          : null;
      case 'success':
      case 'error':
        return { label: 'Pindai lagi', onPress: scan, tone: 'solid' as const };
      case 'ready':
        return { label: 'Mulai pindai', onPress: scan, tone: 'solid' as const };
      default:
        return null;
    }
  })();

  const accent =
    status === 'scanning' ? C.scan : status === 'success' ? C.signal : status === 'error' ? C.danger : C.muted;
  const copy = STATUS_COPY[status];

  const ringStyle = (delay: number) => {
    const p = Animated.modulo(Animated.add(pulse, delay), 1);
    return {
      opacity: p.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
      transform: [{ scale: p.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.35] }) }],
    };
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.screenTitle} accessibilityRole="header">
          Baca NFC
        </Text>

        {/* Target pindai */}
        <View style={styles.targetWrap}>
          {status === 'scanning' && !reduceMotion && (
            <>
              <Animated.View style={[styles.ring, { borderColor: accent }, ringStyle(0)]} />
              <Animated.View style={[styles.ring, { borderColor: accent }, ringStyle(0.5)]} />
            </>
          )}
          <View style={[styles.target, { borderColor: accent }]}>
            <View style={[styles.tagCard, { backgroundColor: accent }]}>
              <View style={styles.tagChip} />
            </View>
          </View>
        </View>

        <View accessibilityLiveRegion="polite" style={styles.statusBlock}>
          <Text style={[styles.statusTitle, { color: accent === C.muted ? C.ink : accent }]}>{copy.title}</Text>
          <Text style={styles.statusBody}>{status === 'error' ? error : copy.body}</Text>
        </View>

        {primary && (
          <Pressable
            onPress={primary.onPress}
            accessibilityRole="button"
            accessibilityState={{ busy: status === 'scanning' }}
            style={({ pressed }) => [
              styles.button,
              primary.tone === 'solid' ? styles.buttonSolid : styles.buttonOutline,
              pressed && { opacity: 0.8 },
            ]}
          >
            <Text style={[styles.buttonText, primary.tone === 'outline' && { color: C.ink }]}>{primary.label}</Text>
          </Pressable>
        )}

        {/* Hasil pindaian */}
        {current && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Isi tag</Text>

            <View style={styles.panel}>
              <InfoRow label="ID tag" value={current.id} mono />
              <InfoRow label="Teknologi" value={current.techTypes.join(', ') || '-'} />
              <InfoRow
                label="Dibaca"
                value={current.scannedAt.toLocaleTimeString('id-ID')}
                last
              />
            </View>

            {current.records.length === 0 ? (
              <Text style={styles.emptyText}>
                Tag ini tidak berisi data NDEF. Tag kosong atau memakai format lain.
              </Text>
            ) : (
              current.records.map((r, i) => (
                <View key={i} style={styles.recordCard}>
                  <View style={styles.recordHead}>
                    <Text style={styles.recordKind}>{r.kind}</Text>
                    <Text style={styles.recordIndex}>
                      Record {i + 1} dari {current.records.length}
                    </Text>
                  </View>
                  <Text selectable style={[styles.recordValue, r.kind === 'Data mentah' && styles.mono]}>
                    {r.value}
                  </Text>
                  {r.detail && <Text style={styles.recordDetail}>{r.detail}</Text>}
                </View>
              ))
            )}

            <Pressable onPress={() => setShowRaw((v) => !v)} accessibilityRole="button" style={styles.linkButton}>
              <Text style={styles.linkText}>{showRaw ? 'Sembunyikan data mentah' : 'Lihat data mentah'}</Text>
            </Pressable>
            {showRaw && (
              <ScrollView horizontal style={styles.rawBox}>
                <Text selectable style={[styles.mono, styles.rawText]}>
                  {JSON.stringify(current.raw, null, 2)}
                </Text>
              </ScrollView>
            )}
          </View>
        )}

        {/* Riwayat */}
        {history.length > 1 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Riwayat pindaian</Text>
            <View style={styles.panel}>
              {history.map((h, i) => (
                <Pressable
                  key={h.scannedAt.getTime()}
                  onPress={() => {
                    setCurrent(h);
                    setShowRaw(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Tampilkan tag ${h.id}`}
                  style={[styles.historyRow, i === history.length - 1 && { borderBottomWidth: 0 }]}
                >
                  <Text style={[styles.historyId, styles.mono]} numberOfLines={1}>
                    {h.id}
                  </Text>
                  <Text style={styles.historyTime}>{h.scannedAt.toLocaleTimeString('id-ID')}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({ label, value, mono, last }: { label: string; value: string; mono?: boolean; last?: boolean }) {
  return (
    <View style={[styles.infoRow, last && { borderBottomWidth: 0 }]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text selectable style={[styles.infoValue, mono && styles.mono]}>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Gaya
// ---------------------------------------------------------------------------

const TARGET = 188;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  content: { padding: 24, paddingBottom: 48 },
  screenTitle: { fontSize: 28, fontWeight: '700', color: C.ink, letterSpacing: -0.5 },

  targetWrap: {
    height: TARGET * 1.45,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    width: TARGET,
    height: TARGET,
    borderRadius: TARGET / 2,
    borderWidth: 2,
  },
  target: {
    width: TARGET,
    height: TARGET,
    borderRadius: TARGET / 2,
    borderWidth: 2,
    backgroundColor: C.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagCard: {
    width: 92,
    height: 58,
    borderRadius: 9,
    transform: [{ rotate: '-10deg' }],
    padding: 10,
  },
  tagChip: { width: 18, height: 14, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.55)' },

  statusBlock: { alignItems: 'center', marginBottom: 20 },
  statusTitle: { fontSize: 20, fontWeight: '700', marginBottom: 6 },
  statusBody: { fontSize: 15, lineHeight: 22, color: C.muted, textAlign: 'center', maxWidth: 300 },

  button: {
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  buttonSolid: { backgroundColor: C.ink },
  buttonOutline: { borderWidth: 1.5, borderColor: C.ink },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },

  section: { marginTop: 28 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: C.ink, marginBottom: 10 },
  panel: {
    backgroundColor: C.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
    gap: 16,
  },
  infoLabel: { fontSize: 14, color: C.muted },
  infoValue: { fontSize: 14, color: C.ink, flexShrink: 1, textAlign: 'right' },

  recordCard: {
    backgroundColor: C.surface,
    borderRadius: 14,
    borderLeftWidth: 4,
    borderLeftColor: C.signal,
    padding: 16,
    marginBottom: 10,
  },
  recordHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  recordKind: { fontSize: 13, fontWeight: '700', color: C.signal },
  recordIndex: { fontSize: 12, color: C.muted },
  recordValue: { fontSize: 16, lineHeight: 23, color: C.ink },
  recordDetail: { fontSize: 12, color: C.muted, marginTop: 6 },

  emptyText: { fontSize: 14, lineHeight: 21, color: C.muted, marginBottom: 8 },

  linkButton: { paddingVertical: 10 },
  linkText: { fontSize: 15, fontWeight: '600', color: C.scan },
  rawBox: { backgroundColor: C.ink, borderRadius: 12, padding: 14, maxHeight: 280 },
  rawText: { color: '#D8E4E1', fontSize: 12, lineHeight: 18 },

  historyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
    gap: 12,
  },
  historyId: { fontSize: 14, color: C.ink, flexShrink: 1 },
  historyTime: { fontSize: 13, color: C.muted },

  mono: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), fontVariant: ['tabular-nums'] },
});
