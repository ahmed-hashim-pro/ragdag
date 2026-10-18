#!/usr/bin/env bash
# TLS certificate for nginx. Signs with an existing CA when RAGDAG_CA_CERT and
# RAGDAG_CA_KEY point at one (devices that already trust it trust ragdag too);
# otherwise creates a ragdag CA in deploy/certs/.
set -euo pipefail
cd "$(dirname "$0")/.."
out=deploy/certs
names=${RAGDAG_CERT_NAMES:-"localhost $(hostname) $(hostname).local"}
ips=${RAGDAG_CERT_IPS:-"127.0.0.1 $(hostname -I 2>/dev/null | awk '{print $1}')"}

if [[ -n ${RAGDAG_CA_CERT:-} && -n ${RAGDAG_CA_KEY:-} ]]; then
  ca_crt=$RAGDAG_CA_CERT; ca_key=$RAGDAG_CA_KEY
  echo "signing with the existing CA ($ca_crt)"
else
  ca_crt=$out/ca.crt; ca_key=$out/ca.key
  if [[ ! -f $ca_key ]]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$ca_key"
    openssl req -x509 -new -key "$ca_key" -sha256 -days 3650 -subj "/CN=ragdag local CA" -out "$ca_crt"
    echo "created $ca_crt — install it as a trusted CA on client devices"
  fi
fi

san=""
for n in $names; do san+="DNS:$n,"; done
for i in $ips; do san+="IP:$i,"; done
san=${san%,}

umask 077
openssl ecparam -name prime256v1 -genkey -noout -out "$out/server.key"
openssl req -new -key "$out/server.key" -subj "/CN=ragdag" -out "$out/server.csr"
openssl x509 -req -in "$out/server.csr" -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
  -out "$out/server.crt" -days 825 -sha256 \
  -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature" "$san")
cat "$ca_crt" >> "$out/server.crt"   # full chain
chmod 644 "$out/server.crt"; chmod 640 "$out/server.key"
rm -f "$out/server.csr"
echo "wrote $out/server.crt for: $san"
