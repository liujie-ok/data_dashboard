#include <SPI.h>
#include <RF24.h>
#include <nRF24L01.h>
#include <printf.h>

#define CE_PIN 9 
#define CSN_PIN 10 
#define INTERVAL_MS_SIGNAL_LOST 1000 

RF24 radio(CE_PIN, CSN_PIN); 

const byte address[6] = "00001"; 

struct payload {
   char data1[64];  // Must match transmitter payload size
};

payload incomingData; 
unsigned long lastSignalMillis = 0; 

void setup() 
{ 
   Serial.begin(19200);
   printf_begin();
   
   if (!radio.begin()) {
     Serial.println("Hardware not responding!");
     while(1); 
   }

   // --- MATCHING CONFIGURATION ---
   radio.setPALevel(RF24_PA_MAX); 
   radio.setDataRate(RF24_250KBPS);      // Must match Transmitter
   radio.setChannel(100);                // Must match Transmitter
   radio.setPayloadSize(sizeof(payload)); 
   radio.setAutoAck(true); 
   // ------------------------------
   
   radio.openReadingPipe(1, address); 
   radio.startListening();

   Serial.println("--- Receiver Ready ---");
   radio.printDetails(); 
} 

void loop() 
{ 
   if (radio.available()) { 
     radio.read(&incomingData, sizeof(payload)); 
     
    //  Serial.print("Received - Data1: "); 
     Serial.println(incomingData.data1);  
     
     lastSignalMillis = millis(); // Reset the "timeout" clock
   } 

   // Check if the signal has been gone for too long
   if (millis() - lastSignalMillis > INTERVAL_MS_SIGNAL_LOST) {
     lostConnection();
   }
} 

void lostConnection() 
{ 
   static unsigned long lastLostPrint = 0;
   // Only print once every second so we don't flood the serial monitor
   if (millis() - lastLostPrint > 1000) {
     Serial.println("Searching for signal..."); 
     lastLostPrint = millis();
   }
}
