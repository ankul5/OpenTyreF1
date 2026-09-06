import React from 'react';
import { View, Text } from 'react-native';
import { fetchWeatherCall, PitwallResponse } from '../../services/api';
import { PitwallModuleScreen, actualStyles } from '../../components/strategy/pitwall-module-screen';

export default function WeatherScreen() {
  return (
    <PitwallModuleScreen
      title="Weather Strategy"
      moduleKey="pitwall-weather"
      fetchFn={fetchWeatherCall}
      renderActual={(data: PitwallResponse) => {
        const wet = data.actual.isWet as boolean | null;
        const compound = data.actual.compound as string | null;
        return (
          <View style={actualStyles.row}>
            <Text style={actualStyles.label}>ACTUALLY</Text>
            <Text style={actualStyles.value}>
              On {compound || 'unknown compound'}, track {wet ? 'wet' : wet === false ? 'dry' : 'condition unknown'} at this lap
            </Text>
          </View>
        );
      }}
    />
  );
}
