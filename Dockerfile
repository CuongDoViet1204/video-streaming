# Sử dụng image Node.js
FROM node:20

# Cài đặt FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg

# Tạo thư mục ứng dụng trong container
WORKDIR /usr/src/app

# Copy package.json và cài đặt các phụ thuộc
COPY package*.json ./
RUN npm install

# Copy toàn bộ mã nguồn vào container
COPY . .

# Mở cổng 3000
EXPOSE 5173

# Khởi động ứng dụng
CMD [ "npm", "start" ]
