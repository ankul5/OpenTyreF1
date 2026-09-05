import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SessionTrack, TrackMapData } from '../services/api';
import { OpenTyreF1Theme } from '../constants/theme';
import { Hairline } from './hairline';
import { TrackMap } from './charts/track-map';
import { flagEmoji } from '../constants/countries';

/** "2026-08-23" -> "23 Aug 2026", without pulling in a date library. */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

/**
 * Circuit dossier shown behind the Live screen's "Track" segment: where the
 * race is, what the conditions were, and how it has gone here before.
 *
 * The map is drawn from the same telemetry trace the screen already fetches —
 * it is passed in rather than re-requested, because that call is the expensive
 * one on this screen.
 */
export function TrackPanel({
  track,
  map,
  mapLoading,
}: {
  track: SessionTrack | undefined;
  map: TrackMapData | undefined;
  mapLoading: boolean;
}) {
  if (!track) {
    return (
      <View style={styles.placeholder}>
        <Text style={styles.hint}>Loading circuit…</Text>
      </View>
    );
  }

  const w = track.weather;
  const flag = flagEmoji(track.country);
  const date = formatDate(track.date);

  return (
    <View>
      {/* Location */}
      <View style={styles.locationRow}>
        {flag && <Text style={styles.flag}>{flag}</Text>}
        <View style={{ flex: 1 }}>
          <Text style={styles.circuitName}>{track.circuitName ?? track.circuit ?? 'Circuit'}</Text>
          <Text style={styles.locationText}>
            {[track.location, track.country].filter(Boolean).join(', ')}
          </Text>
        </View>
      </View>

      {/* Circuit traced from real telemetry coordinates */}
      {map ? (
        <TrackMap points={map.points} bounds={map.bounds} />
      ) : (
        <View style={styles.mapPlaceholder}>
          <Text style={styles.hint}>
            {mapLoading ? 'Tracing circuit from telemetry…' : 'Track map unavailable.'}
          </Text>
        </View>
      )}

      {/* Conditions */}
      <Text style={styles.sectionTitle}>Conditions</Text>
      <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.xs }} />
      {w ? (
        <>
          {w.trackTemperature != null && (
            <Row label="Track temp" value={`${w.trackTemperature.toFixed(1)}°C`} />
          )}
          {w.airTemperature != null && (
            <Row label="Air temp" value={`${w.airTemperature.toFixed(1)}°C`} />
          )}
          {w.humidity != null && <Row label="Humidity" value={`${w.humidity.toFixed(0)}%`} />}
          {w.windSpeed != null && <Row label="Wind" value={`${w.windSpeed.toFixed(1)} m/s`} />}
          <Row label="Conditions" value={w.rainfall ? 'Wet' : 'Dry'} />
        </>
      ) : (
        <Text style={styles.hint}>No weather recorded for this session.</Text>
      )}

      {/* Circuit facts */}
      <Text style={styles.sectionTitle}>Circuit</Text>
      <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.xs }} />
      {date && <Row label="Race date" value={date} />}
      <Row label="Race distance" value={`${track.totalLaps} laps`} />
      {track.history.firstGrandPrix != null && (
        <Row label="First Grand Prix" value={String(track.history.firstGrandPrix)} />
      )}
      {track.history.timesHeld > 0 && (
        <Row
          label="Held here"
          value={`${track.history.timesHeld}× since ${track.history.firstGrandPrix}`}
        />
      )}
      {track.lat != null && track.lng != null && (
        <Row label="Coordinates" value={`${track.lat.toFixed(3)}, ${track.lng.toFixed(3)}`} />
      )}

      {/* Fastest lap on record */}
      {track.lapRecord && (
        <>
          <Text style={styles.sectionTitle}>Fastest race lap</Text>
          <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.sm }} />
          <View style={styles.recordRow}>
            <Ionicons name="stopwatch-outline" size={18} color={OpenTyreF1Theme.colors.highlight} />
            <Text style={styles.recordTime}>{track.lapRecord.time}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.recordDriver} numberOfLines={1}>
                {track.lapRecord.driverName ?? track.lapRecord.code ?? '—'}
              </Text>
              <Text style={styles.recordNote}>
                {track.lapRecord.year} · {track.lapRecord.note}
              </Text>
            </View>
          </View>
        </>
      )}

      {/* Past winners */}
      <Text style={styles.sectionTitle}>Recent winners here</Text>
      <Hairline style={{ marginBottom: OpenTyreF1Theme.spacing.xs }} />
      {track.pastWinners.length === 0 ? (
        <Text style={styles.hint}>No earlier edition on record.</Text>
      ) : (
        track.pastWinners.map((wi, i) => (
          <View key={`${wi.year}-${wi.driverId}`}>
            <View style={styles.winnerRow}>
              <Text style={styles.winnerYear}>{wi.year}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.winnerName} numberOfLines={1}>
                  {wi.driverName}
                </Text>
                <Text style={styles.winnerTeam} numberOfLines={1}>
                  {wi.team ?? '—'}
                  {wi.grid != null ? ` · from P${wi.grid}` : ''}
                </Text>
              </View>
              <Ionicons name="trophy" size={14} color={OpenTyreF1Theme.colors.highlight} />
            </View>
            {i < track.pastWinners.length - 1 && <Hairline />}
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { paddingVertical: 40, alignItems: 'center' },

  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: OpenTyreF1Theme.spacing.md,
    paddingBottom: OpenTyreF1Theme.spacing.md,
  },
  flag: { fontSize: 34 },
  circuitName: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 17,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  locationText: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 2,
  },

  mapPlaceholder: { height: 120, alignItems: 'center', justifyContent: 'center' },

  sectionTitle: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
    marginTop: OpenTyreF1Theme.spacing.xl,
    marginBottom: OpenTyreF1Theme.spacing.sm,
  },

  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  infoLabel: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
  infoValue: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 13,
    color: OpenTyreF1Theme.colors.textPrimary,
  },

  recordRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  recordTime: {
    fontFamily: OpenTyreF1Theme.fonts.monoBold,
    fontSize: 20,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  recordDriver: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  recordNote: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 1,
  },

  winnerRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12 },
  winnerYear: {
    fontFamily: OpenTyreF1Theme.fonts.mono,
    fontSize: 14,
    color: OpenTyreF1Theme.colors.textSecondary,
    width: 40,
  },
  winnerName: {
    fontFamily: OpenTyreF1Theme.fonts.bodySemiBold,
    fontSize: 15,
    color: OpenTyreF1Theme.colors.textPrimary,
  },
  winnerTeam: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 11,
    color: OpenTyreF1Theme.colors.textTertiary,
    marginTop: 1,
  },

  hint: {
    fontFamily: OpenTyreF1Theme.fonts.body,
    fontSize: 12,
    color: OpenTyreF1Theme.colors.textTertiary,
  },
});
