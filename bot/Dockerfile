FROM node:24-alpine

WORKDIR /app
RUN apk add --no-cache fontconfig font-noto font-noto-arabic && fc-cache -f
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY . ./

CMD ["npm", "start"]
