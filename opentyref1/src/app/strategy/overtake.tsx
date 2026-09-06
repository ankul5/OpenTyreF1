import React from 'react';
import { View, Text } from 'react-native';
import { fetchOvertakeCall, PitwallResponse } from '../../services/api';
import { PitwallModuleScreen, actualStyles } from '../../components/strategy/pitwall-module-screen';

export default function OvertakeScreen() {
  return (
    <PitwallModuleScreen
      title="Overtake Strategy"
      moduleKey="pitwall-overtake"
      fetchFn={fetchOvertakeCall}
      renderActual={(data: PitwallResponse) => {
        const attempted = data.actual.attempted as boolean;
        const succeeded = data.actual.succeeded as boolean | null;
        const text = !attempted
          ? 'No overtake attempt registered on this lap'
          : succeeded
          ? 'The pass was completed by the next lap'
          : 'Attempted, but the pass did not complete by the next lap';
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
