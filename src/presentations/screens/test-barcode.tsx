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
  type CodeType,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
} from 'react-native-vision-camera'; // butuh v4.x (useCodeScanner tidak ada di v5)

// ---------------------------------------------------------------------------
// Warna (sama dengan NfcReaderScreen & QrScannerScreen)
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

// ---------------------------------------------------------------------------
// Jenis barcode yang dipindai
// ---------------------------------------------------------------------------

// Codabar di iOS butuh iOS 15.4+, di bawah itu Vision Camera melempar error.
const IOS_VERSION = Platform.OS === 'ios' ? parseFloat(String(Platform.Version)) : 0;
const CODE_TYPES: CodeType[] = [
  'ean-13',
  'ean-8',
  'upc-a',
  'upc-e',
  'code-128',
  'code-39',
  'code-93',
  'itf',
  ...(Platform.OS === 'android' || IOS_VERSION >= 15.4 ? (['codabar'] as CodeType[]) : []),
];

const TYPE_LABEL: Record<string, string> = {
  'ean-13': 'EAN-13',
  'ean-8': 'EAN-8',
  'upc-a': 'UPC-A',
  'upc-e': 'UPC-E',
  'code-128': 'Code 128',
  'code-39': 'Code 39',
  'code-93': 'Code 93',
  itf: 'ITF',
  codabar: 'Codabar',
  unknown: 'Tidak dikenal',
};

// Awalan GS1 menunjukkan negara tempat kode didaftarkan, bukan negara produksi.
const GS1_PREFIX: [number, number, string][] = [
  [0, 19, 'Amerika Serikat & Kanada'],
  [30, 39, 'Amerika Serikat & Kanada'],
  [60, 139, 'Amerika Serikat & Kanada'],
  [300, 379, 'Prancis'],
  [400, 440, 'Jerman'],
  [450, 459, 'Jepang'],
  [490, 499, 'Jepang'],
  [471, 471, 'Taiwan'],
  [480, 480, 'Filipina'],
  [489, 489, 'Hong Kong'],
  [500, 509, 'Inggris'],
  [690, 699, 'Tiongkok'],
  [760, 769, 'Swiss'],
  [800, 839, 'Italia'],
  [840, 849, 'Spanyol'],
  [870, 879, 'Belanda'],
  [880, 880, 'Korea Selatan'],
  [885, 885, 'Thailand'],
  [888, 888, 'Singapura'],
  [893, 893, 'Vietnam'],
  [899, 899, 'Indonesia'],
  [930, 939, 'Australia'],
  [955, 955, 'Malaysia'],
  [977, 977, 'ISSN (majalah & terbitan berkala)'],
  [978, 979, 'ISBN (buku)'],
];

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Validasi digit cek GTIN (EAN-8, UPC-A, EAN-13). null = tidak berlaku. */
function gtinChecksum(value: string): boolean | null {
  if (!/^\d+$/.test(value) || ![8, 12, 13, 14].includes(value.length)) return null;
  const digits = value.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function gs1Country(value: string, type: string): string | null {
  if (type === 'upc-a') return 'Amerika Serikat & Kanada';
  if (type !== 'ean-13' || value.length !== 13) return null;
  const prefix = parseInt(value.slice(0, 3), 10);
  return GS1_PREFIX.find(([from, to]) => prefix >= from && prefix <= to)?.[2] ?? null;
}

type BarcodeInfo = {
  value: string;
  type: string;
  label: string;
  rows: [string, string][];
};

function describe(value: string, rawType: string): BarcodeInfo {
  // iOS melaporkan UPC-A sebagai EAN-13 berawalan 0
  let type = rawType;
  if (type === 'ean-13' && value.length === 13 && value.startsWith('0')) type = 'upc-a';

  const rows: [string, string][] = [
    ['Format', TYPE_LABEL[type] ?? type],
    ['Panjang', `${value.length} karakter`],
  ];

  if (type === 'ean-13' || type === 'ean-8' || type === 'upc-a') {
    const ok = gtinChecksum(value);
    if (ok !== null) rows.push(['Digit cek', ok ? 'Valid' : 'Tidak valid, coba pindai ulang']);
  }
  const country = gs1Country(value, type);
  if (country) rows.push(['Terdaftar di', country]);

  return { value, type, label: TYPE_LABEL[type] ?? type, rows };
}

type ListItem = { value: string; type: string; count: number; lastAt: number };
type Mode = 'single' | 'batch';

// ---------------------------------------------------------------------------
// Komponen
// ---------------------------------------------------------------------------

export default function BarcodeScannerScreen() {
  const { width } = useWindowDimensions();
  const frameW = Math.min(width * 0.86, 360);
  const frameH = Math.round(frameW * 0.42); // barcode 1D itu lebar & pendek

  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const [asked, setAsked] = useState(false);

  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [torch, setTorch] = useState(false);
  const [mode, setMode] = useState<Mode>('single');
  const [result, setResult] = useState<BarcodeInfo | null>(null);
  const [list, setList] = useState<ListItem[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);

  const modeRef = useRef<Mode>('single');
  const locked = useRef(false);
  const candidate = useRef<{ value: string; hits: number }>({ value: '', hits: 0 });
  const lastAdded = useRef<Record<string, number>>({});
  const sweep = useRef(new Animated.Value(0)).current;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    if (!hasPermission && !asked) requestPermission().finally(() => setAsked(true));
  }, [hasPermission, asked, requestPermission]);

  useEffect(() => {
    const appSub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const motionSub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      appSub.remove();
      motionSub.remove();
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  const scanning = hasPermission && !!device && !result;

  // Garis laser horizontal yang bergerak naik-turun
  useEffect(() => {
    if (!scanning || reduceMotion) {
      sweep.stopAnimation();
      sweep.setValue(0.5);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(sweep, { toValue: 0, duration: 1100, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scanning, reduceMotion, sweep]);

  const showFlash = (text: string) => {
    setFlash(text);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1400);
  };

  const codeScanner = useCodeScanner({
    codeTypes: CODE_TYPES,
    onCodeScanned: (codes) => {
      if (locked.current) return;
      const code = codes.find((c) => c.value);
      if (!code?.value) return;

      // Barcode 1D kadang salah baca satu frame; terima hanya jika nilai sama
      // terbaca dua kali berturut-turut.
      const c = candidate.current;
      if (c.value === code.value) c.hits += 1;
      else candidate.current = { value: code.value, hits: 1 };
      if (candidate.current.hits < 2) return;
      candidate.current = { value: '', hits: 0 };

      const info = describe(code.value, code.type);

      if (modeRef.current === 'single') {
        locked.current = true;
        Vibration.vibrate(40);
        setTorch(false);
        setResult(info);
        return;
      }

      // Mode beruntun: jeda 1,5 detik untuk barcode yang sama agar tidak terhitung berkali-kali
      const now = Date.now();
      if (now - (lastAdded.current[info.value] ?? 0) < 1500) return;
      lastAdded.current[info.value] = now;
      Vibration.vibrate(30);
      setList((prev) => {
        const idx = prev.findIndex((p) => p.value === info.value);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], count: next[idx].count + 1, lastAt: now };
          return [next[idx], ...next.filter((_, i) => i !== idx)];
        }
        return [{ value: info.value, type: info.type, count: 1, lastAt: now }, ...prev];
      });
      showFlash(info.value);
    },
  });

  const scanAgain = useCallback(() => {
    setResult(null);
    locked.current = false;
  }, []);

  const switchMode = (m: Mode) => {
    setMode(m);
    setResult(null);
    locked.current = false;
  };

  const shareList = () => {
    const text = list.map((i) => `${i.value}\t${TYPE_LABEL[i.type] ?? i.type}\t${i.count}`).join('\n');
    Share.share({ message: `Barcode\tFormat\tJumlah\n${text}` });
  };

  // ---------------- Izin & perangkat ----------------

  if (!hasPermission) {
    return (
      <MessageScreen
        title={asked ? 'Izin kamera ditolak' : 'Meminta izin kamera'}
        body={
          asked
            ? 'Kamera dibutuhkan untuk memindai barcode. Izinkan akses kamera di pengaturan aplikasi.'
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

  const laserY = sweep.interpolate({ inputRange: [0, 1], outputRange: [10, frameH - 12] });
  const totalItems = list.reduce((n, i) => n + i.count, 0);

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

      {/* Lapisan gelap dengan jendela persegi panjang */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.shade} />
        <View style={{ flexDirection: 'row', height: frameH }}>
          <View style={styles.shade} />
          <View style={[styles.window, { width: frameW, height: frameH }]}>
            {scanning && (
              <Animated.View
                style={[styles.laser, { transform: [{ translateY: reduceMotion ? frameH / 2 : laserY }] }]}
              />
            )}
          </View>
          <View style={styles.shade} />
        </View>
        <View style={[styles.shade, styles.hintArea]}>
          {!result && (
            <Text style={styles.hint} accessibilityLiveRegion="polite">
              {mode === 'single'
                ? 'Posisikan barcode mendatar di dalam kotak.'
                : 'Pindai barang satu per satu. Setiap barcode masuk ke daftar.'}
            </Text>
          )}
          {flash && (
            <View style={styles.flash} accessibilityLiveRegion="polite">
              <Text style={styles.flashText}>Ditambahkan: {flash}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Bilah atas */}
      <SafeAreaView style={styles.topBar} pointerEvents="box-none">
        <View style={styles.topRow}>
          <Text style={styles.title} accessibilityRole="header">
            Pindai barcode
          </Text>
          {device.hasTorch && !result && (
            <Pressable
              onPress={() => setTorch((t) => !t)}
              accessibilityRole="switch"
              accessibilityState={{ checked: torch }}
              accessibilityLabel="Senter"
              style={[styles.pill, torch && styles.pillOn]}
            >
              <Text style={[styles.pillText, torch && { color: C.ink }]}>{torch ? 'Senter nyala' : 'Senter'}</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.segment} accessibilityRole="tablist">
          {(['single', 'batch'] as Mode[]).map((m) => (
            <Pressable
              key={m}
              onPress={() => switchMode(m)}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === m }}
              style={[styles.segmentItem, mode === m && styles.segmentActive]}
            >
              <Text style={[styles.segmentText, mode === m && { color: C.ink }]}>
                {m === 'single' ? 'Sekali pindai' : 'Beruntun'}
              </Text>
            </Pressable>
          ))}
        </View>
      </SafeAreaView>

      {/* Hasil: mode sekali pindai */}
      {mode === 'single' && result && (
        <View style={styles.sheet} accessibilityViewIsModal>
          <SafeAreaView>
            <ScrollView contentContainerStyle={styles.sheetContent} bounces={false}>
              <Text style={styles.kind}>{result.label}</Text>
              <Text selectable style={styles.code} accessibilityLiveRegion="polite">
                {result.value}
              </Text>

              <View style={styles.panel}>
                {result.rows.map(([k, v], i, arr) => (
                  <View key={k} style={[styles.row, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                    <Text style={styles.rowKey}>{k}</Text>
                    <Text style={[styles.rowVal, v.startsWith('Tidak valid') && { color: C.danger }]}>{v}</Text>
                  </View>
                ))}
              </View>

              <View style={styles.actions}>
                <Button
                  label="Cari di web"
                  onPress={() => Linking.openURL(`https://www.google.com/search?q=${encodeURIComponent(result.value)}`)}
                />
                <Button label="Bagikan" tone="outline" onPress={() => Share.share({ message: result.value })} />
                <Button label="Pindai lagi" tone="outline" onPress={scanAgain} />
              </View>
            </ScrollView>
          </SafeAreaView>
        </View>
      )}

      {/* Daftar: mode beruntun */}
      {mode === 'batch' && (
        <View style={[styles.sheet, styles.batchSheet]}>
          <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.batchHead}>
              <Text style={styles.batchTitle}>
                {list.length === 0 ? 'Belum ada barcode' : `${list.length} barcode, ${totalItems} kali terpindai`}
              </Text>
              {list.length > 0 && (
                <Pressable onPress={() => { setList([]); lastAdded.current = {}; }} accessibilityRole="button" hitSlop={8}>
                  <Text style={styles.linkDanger}>Hapus semua</Text>
                </Pressable>
              )}
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 24 }}>
              {list.length === 0 ? (
                <Text style={styles.emptyText}>Arahkan kamera ke barcode pertama untuk mulai mengisi daftar.</Text>
              ) : (
                list.map((item, i) => (
                  <View key={item.value} style={[styles.listRow, i === list.length - 1 && { borderBottomWidth: 0 }]}>
                    <View style={{ flexShrink: 1 }}>
                      <Text selectable style={styles.listCode}>{item.value}</Text>
                      <Text style={styles.listType}>{TYPE_LABEL[item.type] ?? item.type}</Text>
                    </View>
                    <Text style={styles.listCount} accessibilityLabel={`Jumlah ${item.count}`}>
                      ×{item.count}
                    </Text>
                  </View>
                ))
              )}
            </ScrollView>

            {list.length > 0 && (
              <View style={styles.batchFooter}>
                <Button label="Bagikan daftar" onPress={shareList} />
              </View>
            )}
          </SafeAreaView>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Komponen kecil
// ---------------------------------------------------------------------------

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

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace' });

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  shade: { flex: 1, backgroundColor: C.shade },
  window: { borderWidth: 2, borderColor: '#FFFFFF', borderRadius: 12, overflow: 'hidden' },
  laser: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: '#FF4D3D',
    shadowColor: '#FF4D3D',
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  hintArea: { alignItems: 'center', paddingTop: 20, paddingHorizontal: 32 },
  hint: { color: '#FFFFFF', fontSize: 15, lineHeight: 22, textAlign: 'center', maxWidth: 300 },
  flash: { marginTop: 14, backgroundColor: C.signal, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  flashText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', fontFamily: MONO },

  topBar: { position: 'absolute', top: 0, left: 0, right: 0 },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'android' ? 16 : 8,
  },
  title: { color: '#FFFFFF', fontSize: 24, fontWeight: '700', letterSpacing: -0.4 },
  pill: {
    paddingHorizontal: 16,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.7)',
    justifyContent: 'center',
  },
  pillOn: { backgroundColor: '#FFFFFF', borderColor: '#FFFFFF' },
  pillText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },

  segment: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    marginHorizontal: 20,
    marginTop: 14,
    padding: 3,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  segmentItem: { paddingHorizontal: 14, height: 34, borderRadius: 17, justifyContent: 'center' },
  segmentActive: { backgroundColor: '#FFFFFF' },
  segmentText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '72%',
    backgroundColor: C.bg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  sheetContent: { padding: 24, paddingBottom: 16 },
  kind: { fontSize: 14, fontWeight: '700', color: C.signal, marginBottom: 4 },
  code: {
    fontFamily: MONO,
    fontSize: 28,
    lineHeight: 36,
    letterSpacing: 1.5,
    color: C.ink,
    marginBottom: 14,
    fontVariant: ['tabular-nums'],
  },

  panel: {
    backgroundColor: C.surface,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.line,
    paddingHorizontal: 16,
    marginBottom: 14,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
  },
  rowKey: { fontSize: 14, color: C.muted },
  rowVal: { fontSize: 14, color: C.ink, flexShrink: 1, textAlign: 'right' },

  actions: { gap: 10 },
  button: { height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  buttonSolid: { backgroundColor: C.ink },
  buttonOutline: { borderWidth: 1.5, borderColor: C.ink },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },

  batchSheet: { height: '40%' },
  batchHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
    paddingBottom: 8,
  },
  batchTitle: { fontSize: 16, fontWeight: '700', color: C.ink, flexShrink: 1 },
  linkDanger: { fontSize: 14, fontWeight: '600', color: C.danger },
  emptyText: { fontSize: 14, lineHeight: 21, color: C.muted, paddingVertical: 8 },
  listRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.line,
    gap: 12,
  },
  listCode: { fontFamily: MONO, fontSize: 16, color: C.ink, fontVariant: ['tabular-nums'] },
  listType: { fontSize: 12, color: C.muted, marginTop: 2 },
  listCount: { fontSize: 18, fontWeight: '700', color: C.signal, fontVariant: ['tabular-nums'] },
  batchFooter: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 12 },

  messageRoot: { flex: 1, backgroundColor: C.bg },
  messageInner: { flex: 1, justifyContent: 'center', padding: 32, gap: 12 },
  messageTitle: { fontSize: 22, fontWeight: '700', color: C.ink },
  messageBody: { fontSize: 15, lineHeight: 22, color: C.muted, marginBottom: 12 },
});
