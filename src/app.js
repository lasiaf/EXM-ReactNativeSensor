import React from 'react';


import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  
  TestHello,
  TestQR,
  Test,
  NFCReader

} from './presentations/screens';



const Stack = createNativeStackNavigator();

const Apps = () => {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName='Test'>
        <Stack.Screen name='TestHello' component={TestHello} options={{ headerShown: false }} />
        <Stack.Screen name='TestQR' component={TestQR} options={{ headerShown: false }} />
        <Stack.Screen name='Test' component={Test} options={{ headerShown: false }} />
        <Stack.Screen name='NFCReader' component={NFCReader} options={{ headerShown: false }} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}

export default Apps
