// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs-extra");
const path = require("path");
const cors = require('cors');
const compression = require('compression');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const moment = require('moment');
const AWS = require('aws-sdk');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;
  
// Enable CORS
//hi message 
app.get('/hi', (req, res) => {
  res.send('Hello World');
});



app.use(cors({
  origin: ['http://localhost:3000', 'https://master.d39o0gekkt599.amplifyapp.com'],
  allowedHeaders: ['Content-Type']
}));

// Modify directory structure
const baseDir = path.join(__dirname, "classes");
fs.ensureDirSync(baseDir);

// Enable JSON and URL-encoded body parsing
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    const folder = req.body.folder || 'existing';
    const className = req.body.class;

    // Class name is now optional
    const classPath = path.join(baseDir, className || 'default');
    const uploadPath = path.join(classPath, folder);
    
    fs.ensureDirSync(uploadPath);
    cb(null, uploadPath);
  },
  filename: function(req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Not an image! Please upload an image.'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Configure AWS SDK
AWS.config.update({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// Initialize Rekognition
const rekognition = new AWS.Rekognition();
const s3 = new AWS.S3();
const dynamoDB = new AWS.DynamoDB.DocumentClient();
const dynamoDBTableName = 'Tableaws';

const s3BucketName = "shailendrasirclasses";

// Function to handle attendance records
async function recordAttendance(className, imagePath, mode) {
  try {
    // Ensure className is valid and exists
    if (!className) {
      throw new Error('Class name is required');
    }

    const date = moment().format('YYYY-MM-DD');
    const time = moment().format('HH:mm:ss');
    const csvPath = path.join(baseDir, className, 'attendance', `${date}.csv`);
    
    if (!fs.existsSync(csvPath)) {
      const csvWriter = createCsvWriter({
        path: csvPath,
        header: [{ id: 'name', title: 'Name' },
          { id: 'timestamp', title: 'Timestamp' },
          { id: 'presentTime', title: 'Present Time' },
          { id: 'checkoutTime', title: 'Checked Out Time' }
        ]
      });
      await csvWriter.writeRecords([]);
    }

    const recognizedName = await recognizeFace(imagePath, className);
    
    if (!recognizedName) {
      throw new Error('No face recognized or face not registered');
    }

    // Read existing records
    const records = [];
    if (fs.existsSync(csvPath)) {
      const data = await fs.promises.readFile(csvPath, 'utf8');
      records.push(...data.split('\n').map(line => line.split(',')));
    }

    const recordIndex = records.findIndex(record => record[1] === recognizedName);

    if (mode === 'checkout') {
      if (recordIndex === -1 || records[recordIndex][3]) {
        throw new Error(`${recognizedName} cannot check out without being marked present first`);
      }
      // Update the existing record with checkout time
      records[recordIndex][3] = time;
    } else if (mode === 'attendance') {
      if (recordIndex !== -1) {
        throw new Error(`${recognizedName} is already marked present`);
      }
      // Add a new record for attendance
      records.push([`${date} ${time}`, recognizedName, time, '']);
    }

    // Write updated records back to the CSV
    const csvWriter = createCsvWriter({
      path: csvPath,
      header: [
        { id: 'timestamp', title: 'Timestamp' },
        { id: 'name', title: 'Name' },
        { id: 'presentTime', title: 'Present Time' },
        { id: 'checkoutTime', title: 'Checked Out Time' }
      ]
    });

    await csvWriter.writeRecords(records.map(record => ({
      timestamp: record[0],
      name: record[1],
      presentTime: record[2],
      checkoutTime: record[3]
    })));

    return {
      success: true,
      name: recognizedName,
      message: `${mode === 'attendance' ? 'Present' : 'Checked Out'} marked for ${recognizedName}`
    };
  } catch (error) {
    console.error('Error recording attendance:', error);
    throw error;
  }
}

// Function to handle face recognition
async function recognizeFace(imagePath, className) {
  try {
    // Load the captured image
    const img = await loadImage(imagePath);
    const detection = await faceapi.detectSingleFace(img)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      throw new Error('No face detected in the image');
    }

    // Load reference images and create face descriptors
    const classPath = path.join(baseDir, className, 'existing');
    const labeledDescriptors = await loadTrainingData(classPath);
    
    if (labeledDescriptors.length === 0) {
      throw new Error('No registered faces found for comparison');
    }

    // Create face matcher
    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
    const match = faceMatcher.findBestMatch(detection.descriptor);

    // Extract only the name without the percentage
    const recognizedName = match.label !== 'unknown' ? match.label : null;

    return recognizedName;
  } catch (error) {
    console.error('Face recognition error:', error);
    throw error;
  }
}

// Function to load training data
async function loadTrainingData(classPath) {
  const labeledDescriptors = [];
  const dirs = await fs.readdir(classPath);

  for (const personName of dirs) {
    const personPath = path.join(classPath, personName);
    const stat = await fs.stat(personPath);
    
    if (!stat.isDirectory()) continue;

    const descriptors = [];
    const files = await fs.readdir(personPath);

    for (const file of files) {
      if (!file.match(/\.(jpg|jpeg|png)$/)) continue;

      const img = await loadImage(path.join(personPath, file));
      const detection = await faceapi.detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection) {
        descriptors.push(detection.descriptor);
      }
    }

    if (descriptors.length > 0) {
      labeledDescriptors.push(
        new faceapi.LabeledFaceDescriptors(personName, descriptors)
      );
    }
  }

  return labeledDescriptors;
}

const ensureS3FolderExists = async (bucket, folderPath) => {
  const params = {
    Bucket: bucket,
    Prefix: folderPath
  };

  const data = await s3.listObjectsV2(params).promise();
  if (data.Contents.length === 0) {
    // Create a dummy file to ensure the folder exists
    const dummyParams = {
      Bucket: bucket,
      Key: `${folderPath}dummy.txt`,
      Body: 'This is a placeholder file to ensure the folder exists.'
    };
    await s3.putObject(dummyParams).promise();
  }
};

// Function to upload image to S3
const uploadToS3 = async (file, className, studentName) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: `classes/${className}/${studentName}/${Date.now()}_${file.originalname}`,
    Body: file.buffer,
    ContentType: file.mimetype
  };

  return s3.upload(params).promise();
};

// Function to record attendance in DynamoDB
const recordAttendanceInDynamoDB = async (className, studentName, status) => {
  const params = {
    TableName: dynamoDBTableName,
    Item: {
      awstable: `${className}-${studentName}`,
      className,
      studentName,
      date: new Date().toISOString().split('T')[0],
      timestamp: new Date().toISOString(),
      status
    }
  };

  return dynamoDB.put(params).promise();
};

// Function to update attendance status in DynamoDB
const updateAttendanceInDynamoDB = async (className, studentName, status) => {
  const params = {
    TableName: dynamoDBTableName,
    Key: {
      awstable: `${className}-${studentName}`
    },
    UpdateExpression: "set #status = :status, #timestamp = :timestamp",
    ExpressionAttributeNames: {
      "#status": "status",
      "#timestamp": "timestamp"
    },
    ExpressionAttributeValues: {
      ":status": status,
      ":timestamp": new Date().toISOString()
    }
  };

  return dynamoDB.update(params).promise();
};

// Function to load training data from S3
const loadTrainingDataFromS3 = async (className) => {
  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Prefix: `classes/${className}/`
  };

  try {
    const data = await s3.listObjectsV2(params).promise();
    if (!data.Contents || data.Contents.length === 0) {
      throw new Error('No training data found for this class');
    }

    const labeledDescriptors = new Map();

    for (const item of data.Contents) {
      if (!item.Key.match(/\.(jpg|jpeg|png)$/i)) continue;

      const studentName = item.Key.split('/')[2];
      if (!studentName) continue;

      const imageData = await s3.getObject({ Bucket: process.env.S3_BUCKET_NAME, Key: item.Key }).promise();
      const img = await loadImage(imageData.Body);
      const detection = await faceapi.detectSingleFace(img)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection) {
        if (!labeledDescriptors.has(studentName)) {
          labeledDescriptors.set(studentName, []);
        }
        labeledDescriptors.get(studentName).push(detection.descriptor);
      }
    }

    return Array.from(labeledDescriptors.entries()).map(([name, descriptors]) => 
      new faceapi.LabeledFaceDescriptors(name, descriptors)
    );
  } catch (error) {
    console.error('Error loading training data:', error);
    throw error;
  }
};

// Function to compare faces using AWS Rekognition
const compareFaces = async (sourceImage, targetImage) => {
  const params = {
    SourceImage: {
      Bytes: sourceImage // Use the image bytes directly
    },
    TargetImage: {
      S3Object: {
        Bucket: process.env.S3_BUCKET_NAME,
        Name: targetImage
      }
    },
    SimilarityThreshold: 90 // Adjust the threshold as needed
  };

  return rekognition.compareFaces(params).promise();
};

// Endpoint to handle image uploads and attendance
app.post("/upload", upload.single('image'), async (req, res) => {
  try {
    const { class: className, name: studentName, folder } = req.body;

    if (!req.file) {
      throw new Error('No file uploaded');  
    }

    // Upload image to S3
    await uploadToS3(req.file, className, studentName);

    if (folder === 'existing') {
      // Registration logic
      await recordAttendanceInDynamoDB(className, studentName, 'Registered');
      res.json({
        success: true,
        message: `Face registered for ${studentName}`
      });
    } else {
      // Load all student images from S3 for the specified class
      const params = {
        Bucket: process.env.S3_BUCKET_NAME,
        Prefix: `classes/${className}/`
      };

      const data = await s3.listObjectsV2(params).promise();
      const imageKeys = data.Contents.map(item => item.Key).filter(key => key.match(/\.(jpg|jpeg|png)$/));

      let recognizedName = null;

      // Compare the uploaded image with each student's image
      for (const key of imageKeys) {
        const comparisonResult = await compareFaces(req.file.buffer, key);
        if (comparisonResult.FaceMatches.length > 0) {
          recognizedName = key.split('/')[2]; // Extract student name from key
          break; // Exit loop on first match
        }
      }

      if (!recognizedName) {
        throw new Error('Face recognition is unmatched among the students');
      }

      // Check attendance status
      const status = folder === 'attendance' ? 'Present' : 'Checked Out';

      // Ensure the person is marked present before checking out
      if (status === 'Checked Out') {
        const params = {
          TableName: dynamoDBTableName,
          Key: {
            awstable: `${className}-${recognizedName}`
          }
        };

        const result = await dynamoDB.get(params).promise();
        if (!result.Item || result.Item.status !== 'Present') {
          throw new Error(`${recognizedName} cannot check out without being marked present first`);
        }
      }

      // Update attendance in DynamoDB
      await updateAttendanceInDynamoDB(className, recognizedName, status);

      res.json({
        success: true,
        message: `${status} marked for ${recognizedName}`
      });
    }
  } catch (error) {
    console.error('Error processing upload:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to process upload'
    });
  }
});

// Endpoint to fetch classes (new endpoint)


app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
