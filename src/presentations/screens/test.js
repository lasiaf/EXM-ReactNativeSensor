import React from 'react';
import {
    View,
    Button,
    StyleSheet,
} from 'react-native';

const TestScreen = ({ navigation }) => {

    return (
        <View style={styles.container}>

            <View style={styles.buttonContainer}>
                <Button
                    title="Hello World"
                    onPress={() =>
                        navigation.navigate('TestHello')
                    }
                />
            </View>

            <View style={styles.buttonContainer}>
                <Button
                    title="QR SCANNER"
                    onPress={() =>
                        navigation.navigate('TestQR')
                    }
                />
            </View>
            
            <View style={styles.buttonContainer}>
                <Button
                    title="NFC SCANNER"
                    onPress={() =>
                        navigation.navigate('NFCReader')
                    }
                />
            </View>

        </View>
    );

}

export default TestScreen;

const styles = StyleSheet.create({

    container: {
        flex: 1,
        justifyContent: 'center',
        padding: 20,
    },

    buttonContainer: {
        marginBottom: 20,
    },

});