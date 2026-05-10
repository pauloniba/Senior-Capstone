import network
import ujson
import urequests
from machine import Pin
from utime import sleep, ticks_ms

# Fill these in for your network + backend.
WIFI_SSID = "YOUR_WIFI_NAME"
WIFI_PASSWORD = "YOUR_WIFI_PASSWORD"

# Points at the AWS deployment (CloudFront -> ALB -> ECS Fargate backend -> RDS).
# The Pico can be on any Wi-Fi with internet access; no laptop or local Docker needed.
# For local dev, swap this for your computer's LAN IP, e.g. "http://192.168.1.100:8080".
API_BASE_URL = "https://d1cbiu3j43blds.cloudfront.net"
DEVICE_UID = "dev-kitchen-01"
SENSOR_TYPE = "temperature"
UNIT = "C"

POST_INTERVAL_SECONDS = 5

led = Pin("LED", Pin.OUT)


def connect_wifi():
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if wlan.isconnected():
        print("Wi-Fi already connected:", wlan.ifconfig())
        return wlan

    print("Connecting to Wi-Fi...")
    wlan.connect(WIFI_SSID, WIFI_PASSWORD)

    start = ticks_ms()
    while not wlan.isconnected():
        led.toggle()
        sleep(0.2)
        if ticks_ms() - start > 20000:
            raise RuntimeError("Wi-Fi connection timeout after 20s")

    led.on()
    print("Connected:", wlan.ifconfig())
    return wlan


def post_reading(value):
    url = API_BASE_URL + "/api/readings"
    payload = {
        "device_uid": DEVICE_UID,
        "value": value,
        "sensor_type": SENSOR_TYPE,
        "unit": UNIT,
    }
    headers = {"Content-Type": "application/json"}

    response = None
    try:
        response = urequests.post(url, data=ujson.dumps(payload), headers=headers)
        print("POST", url)
        print("payload:", payload)
        print("status:", response.status_code)
        print("response:", response.text)
    finally:
        if response:
            response.close()


def read_fake_sensor():
    # Replace this with a real sensor reading (soil moisture, DHT22, etc).
    # Keep float to match backend validation for numeric value.
    return 20.0


def main():
    connect_wifi()
    print("Starting reading loop...")

    while True:
        try:
            value = read_fake_sensor()
            post_reading(value)
            led.toggle()
            sleep(POST_INTERVAL_SECONDS)
        except Exception as err:
            print("Error:", err)
            led.off()
            sleep(2)


main()
