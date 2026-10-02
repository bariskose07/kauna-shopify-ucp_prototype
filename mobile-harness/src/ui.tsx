// Tiny shared UI kit (no design-system dependency).
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native'

export const C = {
  bg: '#f7f4ef',
  card: '#ffffff',
  text: '#1f1b17',
  muted: '#6f665d',
  line: '#e8e1d7',
  accent: '#5c3a26',
  danger: '#a8251d',
  ok: '#4f9a60',
  warnBg: '#fdf3dc',
  warnLine: '#e6c36a',
  dangerBg: '#fbe9e7',
  okBg: '#e8f4ea',
  infoBg: '#eef2f8',
}

/** Spec rule 1: visible on every screen. */
export function TestBanner() {
  return (
    <View style={{ backgroundColor: C.danger, paddingVertical: 6, paddingHorizontal: 12 }}>
      <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center', fontSize: 12 }}>
        TEST – ödemeyi tamamlama, gerçek sipariş verilir
      </Text>
    </View>
  )
}

export function Card({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <View style={s.card}>
      {title ? <Text style={s.h2}>{title}</Text> : null}
      {children}
    </View>
  )
}

export function Btn({ label, onPress, primary, disabled, small }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean; small?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.btn, primary && s.btnPrimary, small && s.btnSmall, (disabled || pressed) && { opacity: disabled ? 0.45 : 0.8 }]}
    >
      <Text style={[s.btnText, primary && { color: '#fff' }, small && { fontSize: 13 }]}>{label}</Text>
    </Pressable>
  )
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <View style={s.seg}>
      {options.map(([v, label]) => (
        <Pressable key={v} onPress={() => onChange(v)} style={[s.segItem, value === v && s.segOn]}>
          <Text style={[s.segText, value === v && { color: C.accent, fontWeight: '700' }]} numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

export function Field({ label, ...p }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput autoCapitalize="none" autoCorrect={false} {...p} style={[s.input, p.style]} placeholderTextColor={C.muted} />
    </View>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode }) {
  const bg = { info: C.infoBg, warn: C.warnBg, danger: C.dangerBg, ok: C.okBg }[tone]
  const bc = { info: '#8ea6c8', warn: C.warnLine, danger: C.danger, ok: C.ok }[tone]
  return <View style={[s.notice, { backgroundColor: bg, borderColor: bc }]}>{typeof children === 'string' ? <Text style={s.small}>{children}</Text> : children}</View>
}

export const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 16, marginBottom: 12 },
  h1: { fontSize: 24, fontWeight: '700', color: C.text, marginBottom: 6, fontFamily: 'Georgia' },
  h2: { fontSize: 17, fontWeight: '700', color: C.text, marginBottom: 8 },
  p: { fontSize: 15, color: C.text },
  small: { fontSize: 13, color: C.text },
  muted: { fontSize: 13, color: C.muted },
  mono: { fontSize: 12, color: C.muted, fontFamily: 'Courier' },
  label: { fontSize: 13, color: C.muted, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: '#d6ccbf', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.text, backgroundColor: '#fff' },
  btn: { borderRadius: 999, borderWidth: 1, borderColor: '#d6ccbf', paddingVertical: 12, paddingHorizontal: 18, alignItems: 'center', backgroundColor: '#fff' },
  btnPrimary: { backgroundColor: C.accent, borderColor: C.accent },
  btnSmall: { paddingVertical: 7, paddingHorizontal: 12 },
  btnText: { fontSize: 15, fontWeight: '600', color: C.text },
  seg: { flexDirection: 'row', backgroundColor: '#fbf9f6', borderWidth: 1, borderColor: C.line, borderRadius: 999, padding: 3, marginBottom: 10 },
  segItem: { flex: 1, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 999, alignItems: 'center' },
  segOn: { backgroundColor: '#fff' },
  segText: { fontSize: 13, color: C.text },
  notice: { borderWidth: 1, borderRadius: 10, padding: 10, marginVertical: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderColor: C.line },
})
