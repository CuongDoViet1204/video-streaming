import express from "express";
import cors from "cors";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from 'fs';
import {exec, spawn} from "child_process"
import { stderr, stdout } from "process";
import { fileURLToPath } from 'url';

import { deleteObject, getDownloadURL, getStorage, ref, uploadBytes, listAll } from "firebase/storage";
import { firebaseApp } from "./config/firebaseConfig.js";

import mime from 'mime-types';

// Tạo __dirname thủ công
const app = express()
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let conversionProgress = {}; // lưu tiến độ chuyển đổi video
let processes = {}; // lưu tiến trình hiện tại
let isStopProcesses = {}; // đánh dấu có dừng việc upload file lên firebase không

// multer middleware

const storage = multer.diskStorage({
    destination: function(req, file, cb) {
        cb(null, './uploads')
    },
    filename: function(req, file, cb) {
        cb(null, file.fieldname + "-" + uuidv4() + path.extname(file.originalname))
    }
})

// multer configuration

const upload = multer({storage: storage})

const firebaseStorage = getStorage()

app.use(
    cors({
        origin: ["http://localhost:3000", "http://localhost:5173"],
        credentials: true
    })
)

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*")
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-type, Accept")
    next()
})

app.use(express.json())
app.use(express.urlencoded({extended: true}))
app.use('/uploads', express.static("uploads"))

app.get('/', function(req, res) {
    res.json({message : "hello"})
})

app.post("/upload", upload.single('file'), async function(req, res) {
    const lessonId = uuidv4()
    const videoPath = req.file.path
    const outputPath = `./uploads/${lessonId}`
    const hlsPath = `${outputPath}/index.m3u8`
    console.log("hslPath", hlsPath)

    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, {recursive: true})
    }

    // const ffmpegCommand = `ffmpeg -i ${videoPath} -codec:v libx264 -codec:a aac -hls_time 10 -hls_playlist_type vod -hls_segment_filename "${outputPath}/segment%03d.ts" -start_number 0 ${hlsPath}`
    // const ffmpegProcess = exec(ffmpegCommand);
    const ffmpegProcess = spawn('ffmpeg', [
        '-i', videoPath,
        '-codec:v', 'libx264',
        '-codec:a', 'aac',
        '-hls_time', '30',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', `${outputPath}/segment%04d.ts`,
        '-start_number', '0',
        hlsPath
    ]);

    const progressId = req.body.progressId
    const videoDuration = await getVideoDuration(videoPath);

    conversionProgress[progressId] = 0;
    processes[progressId] = ffmpegProcess;
    isStopProcesses[progressId] = false

    ffmpegProcess.stderr.on('data', (data) => {
        const match = data.toString().match(/time=(\d+:\d+:\d+\.\d+)/); // Trích xuất thời gian đã xử lý
        if (match && videoDuration) {
            const timeParts = match[1].split(':').map(parseFloat);
            const timeInSeconds = timeParts[0] * 3600 + timeParts[1] * 60 + timeParts[2];
            const percentComplete = Math.min((timeInSeconds / videoDuration) * 100, 100);
            console.log(`Conversion progress ${ffmpegProcess.pid}: ${percentComplete.toFixed(2)}%`);
            conversionProgress[progressId] = percentComplete.toFixed(2);
        }
    });
    ffmpegProcess.on('close', async () => {
        if (!ffmpegProcess.killed) {
            conversionProgress[progressId] = 100;
            delete processes[progressId];
            fs.unlinkSync(videoPath)
            const files = fs.readdirSync(outputPath)
            const filesToRead = files.filter(file => file !== 'index.m3u8')
            var fileHls = fs.readFileSync(hlsPath, 'utf8')
            for (const fileName of filesToRead) {
                if (isStopProcesses[progressId]) {
                    break;
                }
                const filePath = path.join(outputPath, fileName);
                const fileData = fs.readFileSync(filePath);
                const mimeType = mime.lookup(fileName);
                const storageRef = ref(firebaseStorage, `webphim/${lessonId}/${fileName}`)
                const snapshot = await uploadBytes(storageRef, fileData, { contentType: mimeType });
                const downloadURL = await getDownloadURL(storageRef);
                var pathFirebase = downloadURL.split('/o/')[1]
                // Tách phần path từ URL
                const pathEncoded = downloadURL.split('/o/')[1].split('?')[0];
    
                // Giải mã URL
                const pathDecoded = decodeURIComponent(pathEncoded);
                var fileNameTs = pathDecoded.split('/').pop();
                fileHls = fileHls.replace(fileNameTs, pathFirebase)
            }
            if (isStopProcesses[progressId]) {
                delete isStopProcesses[progressId]
                fs.rmSync(outputPath, { recursive: true, force: true });
                const storageRefDel = ref(firebaseStorage, `webphim/${lessonId}`)
                const listResult = await listAll(storageRefDel)
                console.log(listResult.items)
                if (listResult.items.length === 0) {
                    console.log("Thư mục trống hoặc không tồn tại");
                    res.json({
                        code: "204",
                        message: "Stop process success",
                    })
                    return
                }

                // Xóa từng tệp trong thư mục
                const deletePromises = listResult.items.map(itemRef => deleteObject(itemRef));
                await Promise.all(deletePromises);
                console.log(`Đã xóa tất cả các tệp trong thư mục`);
               
                res.json({
                    code: "204",
                    message: "Stop process success",
                })
                return;
            }
            delete isStopProcesses[progressId]

            fs.rmSync(outputPath, { recursive: true, force: true });
            const storageRef = ref(firebaseStorage, `webphim/${lessonId}/index.m3u8`)
            const snapshot = await uploadBytes(storageRef, Buffer.from(fileHls, 'utf-8'), { contentType: 'application/x-mpegurl' });
            const downloadURL = await getDownloadURL(storageRef);
            res.json({
                code: "200",
                message: "Video converted to HLS format",
                url: downloadURL,
            })
        } else {
            delete isStopProcesses[progressId]

            fs.unlinkSync(videoPath)
            fs.rmSync(outputPath, { recursive: true, force: true });
            res.json({
                code: "204",
                message: "Stop process success",
            })
        }
    });
})

function getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
        exec(`ffprobe -i ${videoPath} -show_entries format=duration -v quiet -of csv="p=0"`, (error, stdout) => {
            if (error) return reject(error);
            resolve(parseFloat(stdout));
        });
    });
}

app.get('/progress/:progressId', (req, res) => {
    const progressId = req.params.progressId;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const interval = setInterval(() => {
        const progress = conversionProgress[progressId] || 0;
        res.write(`data: ${JSON.stringify({ progress })}\n\n`);

        if (progress === 100) {
            clearInterval(interval);
            res.write(`data: ${JSON.stringify({ progress: 100, message: 'Conversion completed' })}\n\n`);
            res.end();
            delete conversionProgress[progressId];
        }
    }, 1000);

    req.on('close', () => {
        clearInterval(interval)
    });
});

app.post('/cancel/:id', async (req, res) => {
    const processId = req.params.id;
    isStopProcesses[processId] = true

    if (processes[processId] && !processes[processId].killed) {
        processes[processId].kill('SIGTERM');
        delete processes[processId]; 
        res.status(200).json({ message: `Process ${processId} has been cancelled.` });
    } else {
        res.status(404).json({ message: 'Process not found or already completed.' });
    }
});

app.post('/delete/:id', async (req, res) => {
    const lessonId = req.params.id;
    try {
        const storageRef = ref(firebaseStorage, `webphim/${lessonId}`)
        const listResult = await listAll(storageRef)
        console.log(listResult.items)
        if (listResult.items.length === 0) {
            console.log("Thư mục trống hoặc không tồn tại");
            res.json({
                code: '204',
                message: 'Folder empty or not exist'
            })
            return
        }

        // Xóa từng tệp trong thư mục
        const deletePromises = listResult.items.map(itemRef => deleteObject(itemRef));
        await Promise.all(deletePromises);

        console.log(`Đã xóa tất cả các tệp trong thư mục`);
        res.json({
            code: '200',
            message: 'Delete success'
        })
    } catch (error) {
        console.error("Lỗi khi xóa thư mục:", error);
        res.json({
            code: '400',
            message: 'Delete failed'
        })
    }
})

app.listen(5173, function() {
    console.log('app is listening at port 5173...')
})