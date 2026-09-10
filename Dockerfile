# Runs the tests and the collector exactly as CI does, so "works on my machine"
# and "works in the Action" cannot diverge.
FROM node:22-alpine

WORKDIR /app

# No dependencies at all. Everything here is the Node standard library plus
# WebCrypto, which keeps the supply chain of a thing holding an encryption key
# down to Node itself.
COPY package.json ./
COPY src ./src
COPY tools ./tools
COPY test ./test
COPY web ./web
COPY data ./data

CMD ["npm", "test"]
