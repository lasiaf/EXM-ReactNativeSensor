import React from 'react';
import {
  StyleSheet,
  View,
  Text,
} from 'react-native';

import {
  CodeScanner,
} from 'react-native-vision-camera-barcode-scanner';

const TestQR = () => {

  const handleBarcodeScanned = (barcodes) => {
    console.log('BARCODES:', barcodes);

    if (barcodes.length > 0) {
      const barcode = barcodes[0];

      console.log('QR VALUE:', barcode.value);
      console.log('QR TYPE:', barcode.format);
    }
  };

  const handleError = (error) => {
    console.error('BARCODE SCANNER ERROR:', error);
  };

  return (
    <View style={styles.container}>

      <CodeScanner
        isActive={true}
        barcodeFormats={['qr-code']}
        onBarcodeScanned={handleBarcodeScanned}
        onError={handleError}
      />

      {/* Overlay */}
      <View style={styles.overlay}>

        <View style={styles.scanBox} />

        <Text style={styles.text}>
          Arahkan kamera ke QR Code
        </Text>

      </View>

    </View>
  );
};

const styles = StyleSheet.create({

  container: {
    flex: 1,
    backgroundColor: 'black',
  },

  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },

  scanBox: {
    width: 250,
    height: 250,
    borderWidth: 3,
    borderColor: 'white',
    borderRadius: 12,
  },

  text: {
    marginTop: 30,
    color: 'white',
    fontSize: 16,
  },

});

export default TestQR;