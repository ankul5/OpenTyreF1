import React from 'react';
import { View, Text } from 'react-native';
import { fetchSafetyCarCall, PitwallResponse } from '../../services/api';
import { PitwallModuleScreen, actualStyles } from '../../components/strategy/pitwall-module-screen';

export default function SafetyCarScreen() {
  return (
    <PitwallModuleScreen
      title="Safety Car Strategy"
      moduleKey="pitwall-safety-car"
      fetchFn={fetchSafetyCarCall}
      renderActual={(data: PitwallResponse) => {
        const active = data.actual.eventActive as boolean;
        const type = data.actual.eventType as string | null;
        return (
          <View style={actualStyles.row}>
            <Text style={actualStyles.label}>ACTUALLY</Text>
            <Text style={actualStyles.value}>
              {active ? `${type} active at this lap` : 'No SC/VSC active at this lap'}
            </Text>
          </View>
        );
      }}
    />
  );
}
