import React from 'react';
import { View, Text } from 'react-native';
import { fetchFlagsCall, PitwallResponse } from '../../services/api';
import { PitwallModuleScreen, actualStyles } from '../../components/strategy/pitwall-module-screen';

export default function FlagsScreen() {
  return (
    <PitwallModuleScreen
      title="Red/Yellow Flag Strategy"
      moduleKey="pitwall-flags"
      fetchFn={fetchFlagsCall}
      renderActual={(data: PitwallResponse) => {
        const active = data.actual.flagActive as boolean;
        const type = data.actual.flagType as string | null;
        return (
          <View style={actualStyles.row}>
            <Text style={actualStyles.label}>ACTUALLY</Text>
            <Text style={actualStyles.value}>
              {active ? `${(type ?? '').replace('_', ' ')} flag active at this lap` : 'No flag active at this lap'}
            </Text>
          </View>
        );
      }}
    />
  );
}
