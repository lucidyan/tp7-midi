#!/bin/bash
cd /workspaces/tp7-midi

# Generate self-signed certificate for HTTPS
# Note: For Safari support, use mkcert on host machine instead
if command -v mkcert &> /dev/null; then
    echo "Using mkcert..."
    mkcert -key-file key.pem -cert-file cert.pem localhost 127.0.0.1 ::1
else
    echo "Using openssl (Safari won't trust this cert)..."
    openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes \
        -subj "/CN=localhost" \
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
fi

echo ""
echo "======================================"
echo "Setup complete!"
echo ""
echo "To start HTTPS server:"
echo "  python dev/serve_https.py"
echo ""
echo "Then open: https://localhost:8443"
echo ""
echo "For Safari/iOS support, use mkcert on host:"
echo "  brew install mkcert && mkcert -install"
echo "======================================"
