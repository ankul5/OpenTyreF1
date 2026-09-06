import React from 'react';
import { View, Text } from 'react-native';
import { fetchDefenceCall, PitwallResponse } from '../../services/api';
import { PitwallModuleScreen, actualStyles } from '../../components/strategy/pitwall-module-screen';

export default function DefenceScreen() {
  return (
    <PitwallModuleScreen
      title="Defensive Strategy"
      moduleKey="pitwall-defence"
      fetchFn={fetchDefenceCall}
      renderActual={(data: PitwallResponse) => {
        const passed = data.actual.passed as boolean | null;
        const text = passed == null ? 'No car close enough behind to have attempted a pass' : passed ? 'Position was lost by the next lap' : 'Position was held';
        return (
          <View style={actualStyles.row}>
            <Text style={actualStyles.label}>ACTUALLY</Text>
            <Text style={actualStyles.value}>{text}</Text>
          </View>
        );
      }}
    />
  );
}
