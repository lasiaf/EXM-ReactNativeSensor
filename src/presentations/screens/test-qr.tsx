import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  Vibration,
  View,
  useWindowDimensions,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera';

// ---------------------------------------------------------------------------
// Warna & tipe (sama dengan NfcReaderScreen agar konsisten)
// ---------------------------------------------------------------------------

const C = {
  bg: '#EEF2F0',
  surface: '#FFFFFF',
  ink: '#1D2B2A',
  muted: '#5E6E6C',
  line: '#D5DDDA',
  signal: '#0A7F6F',
  scan: '#2E4FD8',
  danger: '#B3362E',
  shade: 'rgba(12, 20, 19, 0.62)',
};

type ParsedQr =
  | { kind: 'url'; label: 'Tautan'; value: string; url: string }
  | { kind: 'wifi'; label: 'Wi-Fi'; value: string; fields: [string, string][] }
  | { kind: 'email'; label: 'Email'; value: string; url: string }
  | { kind: 'phone'; label: 'Telepon'; value: string; url: string }
  | { kind: 'sms'; label: 'SMS'; value: string; url: string }
  | { kind: 'geo'; label: 'Lokasi'; value: string; url: string }
  | { kind: 'contact'; label: 'Kontak'; value: string; fields: [string, string][] }
  | { kind: 'text'; label: 'Teks'; value: string };

type ScanResult = { raw: string; parsed: ParsedQr; scannedAt: Date };

// ---------------------------------------------------------------------------
// Pengurai isi QR
// ---------------------------------------------------------------------------

function parseWifi(raw: string): [string, string][] {
  // Format: WIFI:T:WPA;S:NamaJaringan;P:katasandi;H:false;;
  const body = raw.slice(5);
  const map: Record<string, string> = {};
  const re = /([TSPH]):((?:\\.|[^;])*);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) map[m[1]] = m[2].replace(/\\(.)/g, '$1');
  const fields: [string, string][] = [];
  if (map.S) fields.push(['Nama jaringan', map.S]);
  if (map.T) fields.push(['Keamanan', map.T === 'nopass' ? 'Terbuka' : map.T]);
  if (map.P) fields.push(['Kata sandi', map.P]);
  if (map.H === 'true') fields.push(['Tersembunyi', 'Ya']);
  return fields;
}

function parseVCard(raw: string): [string, string][] {
  const fields: [string, string][] = [];
  const labels: Record<string, string> = { FN: 'Nama', TEL: 'Telepon', EMAIL: 'Email', ORG: 'Organisasi', TITLE: 'Jabatan', ADR: 'Alamat', URL: 'Situs' };
  raw.split(/\r?\n/).forEach((line) => {
    const idx = line.indexOf(':');
    if (idx < 0) return;
    const key = line.slice(0, idx).split(';')[0].toUpperCase();
    const val = line.slice(idx + 1).replace(/;+/g, ' ').trim();
    if (labels[key] && val) fields.push([labels[key], val]);
  });
  return fields;
}

function parseQr(raw: string): ParsedQr {
  const v = raw.trim();
  const lower = v.toLowerCase();

  if (/^https?:\/\//i.test(v)) return { kind: 'url', label: 'Tautan', value: v, url: v };
  if (lower.startsWith('wifi:')) {
    const fields = parseWifi(v);
    return { kind: 'wifi', label: 'Wi-Fi', value: fields.find((f) => f[0] === 'Nama jaringan')?.[1] ?? v, fields };
  }
  if (lower.startsWith('mailto:')) return { kind: 'email', label: 'Email', value: v.slice(7).split('?')[0], url: v };
  if (lower.startsWith('tel:')) return { kind: 'phone', label: 'Telepon', value: v.slice(4), url: v };
  if (lower.startsWith('smsto:') || lower.startsWith('sms:')) {
    const [, number = '', message = ''] = v.split(':');
    return { kind: 'sms', label: 'SMS', value: number, url: `sms:${number}${message ? `?body=${encodeURIComponent(message)}` : ''}` };
  }
  if (lower.startsWith('geo:')) {
    const coords = v.slice(4).split('?')[0];
    const url = Platform.OS === 'ios' ? `maps:?q=${coords}` : v;
    return { kind: 'geo', label: 'Lokasi', value: coords, url };
  }
  if (lower.startsWith('begin:vcard')) {
    const fields = parseVCard(v);
    return { kind: 'contact', label: 'Kontak', value: fields.find((f) => f[0] === 'Nama')?.[1] ?? 'Kartu kontak', fields };
  }
  return { kind: 'text', label: 'Teks', value: v };
}

const ACTION_LABEL: Partial<Record<ParsedQr['kind'], string>> = {
  url: 'Buka tautan',
  email: 'Tulis email',
  phone: 'Telepon',
  sms: 'Kirim SMS',
  geo: 'Buka di peta',
};

// ---------------------------------------------------------------------------
// Komponen
// ---------------------------------------------------------------------------

export default function QrScannerScreen() {
  const { width } = useWindowDimensions();
  const frame = Math.min(width * 0.7, 280);

  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const [asked, setAsked] = useState(false);

  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [torch, setTorch] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  const locked = useRef(false);
  const sweep = useRef(new Animated.Value(0)).current;

  // Minta izin kamera sekali saat screen dibuka
  useEffect(() => {
    if (!hasPermission && !asked) {
      requestPermission().finally(() => setAsked(true));
    }
  }, [hasPermission, asked, requestPermission]);

  // Matikan kamera saat aplikasi di background
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const motionSub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      sub.remove();
      motionSub.remove();
    };
  }, []);

  const scanning = hasPermission && !!device && !result;

  // Garis sapu di dalam bingkai selama memindai
  useEffect(() => {
    if (!scanning || reduceMotion) {
      sweep.stopAnimation();
      sweep.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(sweep, { toValue: 0, duration: 1800, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scanning, reduceMotion, sweep]);

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: (codes) => {
      if (locked.current) return;
      const value = codes.find((c) => c.value)?.value;
      if (!value) return;
      locked.current = true; // cegah pembacaan berulang
      Vibration.vibrate(40);
      setTorch(false);
      setActionError(null);
      setResult({ raw: value, parsed: parseQr(value), scannedAt: new Date() });
    },
  });

  const scanAgain = useCallback(() => {
    setResult(null);
    setActionError(null);
    locked.current = false;
  }, []);

  const runAction = useCallback(async (url: string) => {
    setActionError(null);
    try {
      await Linking.openURL(url);
    } catch {
      setActionError('Tidak ada aplikasi di ponsel ini yang bisa membuka isi QR tersebut.');
    }
  }, []);

  const share = useCallback(() => {
    if (result) Share.share({ message: result.raw });
  }, [result]);

  // ---------------- Tampilan izin / perangkat ----------------

  if (!hasPermission) {
    return (
      <MessageScreen
        title={asked ? 'Izin kamera ditolak' : 'Meminta izin kamera'}
        body={
          asked
            ? 'Kamera dibutuhkan untuk memindai QR. Izinkan akses kamera di pengaturan aplikasi.'
            : 'Izinkan akses kamera untuk mulai memindai.'
        }
        action={asked ? { label: 'Buka pengaturan', onPress: () => Linking.openSettings() } : undefined}
      />
    );
  }

  if (!device) {
    return (
      <MessageScreen
        title="Kamera tidak ditemukan"
        body="Perangkat ini tidak memiliki kamera belakang yang bisa dipakai. Di emulator, aktifkan kamera virtual terlebih dahulu."
      />
    );
  }

  // ---------------- Tampilan utama ----------------

  const translateY = sweep.interpolate({ inputRange: [0, 1], outputRange: [8, frame - 10] });

  return (
    <View style={styles.root}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={appActive && !result}
        codeScanner={codeScanner}
        torch={torch ? 'on' : 'off'}
        enableZoomGesture
      />

      {/* Lapisan gelap dengan lubang persegi di tengah */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.shade} />
        <View style={{ flexDirection: 'row', height: frame }}>
          <View style={styles.shade} />
          <View style={{ width: frame, height: frame }}>
            <Corner style={{ top: 0, left: 0 }} rotate="0deg" />
            <Corner style={{ top: 0, right: 0 }} rotate="90deg" />
            <Corner style={{ bottom: 0, right: 0 }} rotate="180deg" />
            <Corner style={{ bottom: 0, left: 0 }} rotate="270deg" />
            {scanning && !reduceMotion && (
              <Animated.View style={[styles.sweep, { transform: [{ translateY }] }]} />
            )}
          </View>
          <View style={styles.shade} />
        </View>
        <View style={[styles.shade, styles.hintArea]}>
          {!result && (
            <Text style={styles.hint} accessibilityLiveRegion="polite">
              Arahkan kamera ke kode QR. Pemindaian berjalan otomatis.
            </Text>
          )}
        </View>
      </View>

      {/* Bilah atas */}
      <SafeAreaView style={styles.topBar} pointerEvents="box-none">
        <Text style={styles.title} accessibilityRole="header">
          Pindai QR
        </Text>
        {device.hasTorch && !result && (
          <Pressable
            onPress={() => setTorch((t) => !t)}
            accessibilityRole="switch"
            accessibilityState={{ checked: torch }}
            accessibilityLabel="Senter"
            style={[styles.torchButton, torch && styles.torchOn]}
          >
            <Text style={[styles.torchText, torch && { color: C.ink }]}>{torch ? 'Senter nyala' : 'Senter'}</Text>
          </Pressable>
        )}
      </SafeAreaView>

      {/* Panel hasil */}
      {result && (
        <View style={styles.sheet} accessibilityViewIsModal>
          <SafeAreaView>
            <ScrollView contentContainerStyle={styles.sheetContent} bounces={false}>
              <View style={styles.sheetHead}>
                <Text style={styles.kind}>{result.parsed.label}</Text>
                <Text style={styles.time}>{result.scannedAt.toLocaleTimeString('id-ID')}</Text>
              </View>

              <Text selectable style={styles.value} accessibilityLiveRegion="polite">
                {result.parsed.value}
              </Text>

              {'fields' in result.parsed && result.parsed.fields.length > 0 && (
                <View style={styles.fields}>
                  {result.parsed.fields.map(([k, v], i, arr) => (
                    <View key={k + i} style={[styles.fieldRow, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                      <Text style={styles.fieldKey}>{k}</Text>
                      <Text selectable style={styles.fieldVal}>
                        {v}
                      </Text>
                    </View>
                  ))}
                </View>
              )}

              {result.parsed.kind !== 'text' && result.raw !== result.parsed.value && (
                <Text selectable style={styles.raw} numberOfLines={4}>
                  {result.raw}
                </Text>
              )}

              {actionError && <Text style={styles.error}>{actionError}</Text>}

              <View style={styles.actions}>
                {'url' in result.parsed && (
                  <Button
                    label={ACTION_LABEL[result.parsed.kind] ?? 'Buka'}
                    onPress={() => runAction((result.parsed as { url: string }).url)}
                  />
                )}
                <Button label="Bagikan" onPress={share} tone="outline" />
                <Button label="Pindai lagi" onPress={scanAgain} tone={'url' in result.parsed ? 'outline' : 'solid'} />
              </View>
            </ScrollView>
          </SafeAreaView>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Komponen kecil
// ---------------------------------------------------------------------------

function Corner({ style, rotate }: { style: object; rotate: string }) {
  return <View style={[styles.corner, style, { transform: [{ rotate }] }]} />;
}

function Button({ label, onPress, tone = 'solid' }: { label: string; onPress: () => void; tone?: 'solid' | 'outline' }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, tone === 'solid' ? styles.buttonSolid : styles.buttonOutline, pressed && { opacity: 0.8 }]}
    >
      <Text style={[styles.buttonText, tone === 'outline' && { color: C.ink }]}>{label}</Text>
    </Pressable>
  );
}

function MessageScreen({ title, body, action }: { title: string; body: string; action?: { label: string; onPress: () => void } }) {
  return (
    <SafeAreaView style={styles.messageRoot}>
      <View style={styles.messageInner}>
        <Text style={styles.messageTitle}>{title}</Text>
        <Text style={styles.messageBody}>{body}</Text>
        {action && <Button label={action.label} onPress={action.onPress} />}
      </View>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Gaya
// ---------------------------------------------------------------------------

const CORNER = 34;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  shade: { flex: 1, backgroundColor: C.shade },
  hintArea: { alignItems: 'center', paddingTop: 24, paddingHorizontal: 32 },
  hint: { color: '#FFFFFF', fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 280 },

  corner: {
    position: 'absolute',
    width: CORNER,
    height: CORNER,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderColor: '#FFFFFF',
    borderTopLeftRadius: 14,
  },
  sweep: {
    position: 'absolute',
    left: 12,
    right: 12,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#7FD8C9',
  },

  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 16 : 0,
  },
  title: { color: '#FFFFFF', fontSize: 24, fontWeight: '700', letterSpacing: -0.4, marginTop: 8 },
  torchButton: {
    marginTop: 8,
    paddingHorizontal: 16,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.7)',
    justifyContent: 'center',
  },
  torchOn: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
  torchText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '75%',
    backgroundColor: C.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  sheetContent: { padding: 24, paddingBottom: 16 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  kind: { fontSize: 14, fontWeight: '700', color: C.signal },
  time: { fontSize: 13, color: C.muted },
  value: { fontSize: 20, lineHeight: 28, fontWeight: '600', color: C.ink, marginBottom: 12 },

  fields: {
    backgroundColor: C.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  fieldRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
  },
  fieldKey: { fontSize: 14, color: C.muted },
  fieldVal: { fontSize: 14, color: C.ink, flexShrink: 1, textAlign: 'right' },

  raw: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 12,
    lineHeight: 18,
    color: C.muted,
    marginBottom: 12,
  },
  error: { fontSize: 14, lineHeight: 20, color: C.danger, marginBottom: 12 },

  actions: { gap: 10, marginTop: 4 },
  button: { height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  buttonSolid: { backgroundColor: C.ink },
  buttonOutline: { borderWidth: 1.5, borderColor: C.ink },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },

  messageRoot: { flex: 1, backgroundColor: C.bg },
  messageInner: { flex: 1, justifyContent: 'center', padding: 32, gap: 12 },
  messageTitle: { fontSize: 22, fontWeight: '700', color: C.ink },
  messageBody: { fontSize: 15, lineHeight: 22, color: C.muted, marginBottom: 12 },
});
