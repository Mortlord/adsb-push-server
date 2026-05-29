#!/usr/bin/env python3
"""
Einmalig ausführen um VAPID-Schlüsselpaar zu generieren.
Die Ausgabe als Environment Variables in Railway eintragen.
"""
from pywebpush import webpush, WebPushException
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.backends import default_backend
import base64

# Schlüsselpaar generieren
private_key = ec.generate_private_key(ec.SECP256R1(), default_backend())
public_key  = private_key.public_key()

# Private Key als Base64
from cryptography.hazmat.primitives import serialization
private_bytes = private_key.private_bytes(
    encoding=serialization.Encoding.PEM,
    format=serialization.PrivateFormat.TraditionalOpenSSL,
    encryption_algorithm=serialization.NoEncryption()
)

# Public Key als URL-safe Base64 (für Browser)
public_bytes = public_key.public_bytes(
    encoding=serialization.Encoding.X962,
    format=serialization.PublicFormat.UncompressedPoint
)
public_b64 = base64.urlsafe_b64encode(public_bytes).rstrip(b'=').decode()

print("=== VAPID Keys ===")
print()
print("VAPID_PUBLIC_KEY (in index.html eintragen):")
print(public_b64)
print()
print("VAPID_PRIVATE_KEY (als Railway Environment Variable):")
print(private_bytes.decode())
print()
print("VAPID_EMAIL: deine@email.com")
