import React from 'react';


import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  
  TestHello

} from './presentations/screens';



const Stack = createNativeStackNavigator();

const Apps = () => {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName='TestHello'>
        

        <Stack.Screen name='TestHello' component={TestHello} options={{ headerShown: false }} />
        {/*<Stack.Screen name='TestCreateScreen' component={TestCreateScreen} options={{ headerShown: false }} /> */}
        
      </Stack.Navigator>
    </NavigationContainer>
  )
}

export default Apps
