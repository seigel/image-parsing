const brain = require('brain.js')
const cheerio = require('cheerio')
const childProcess = require('child_process')
const fastGlob = require('fast-glob')
const fs = require('fs')
const javascriptBarcodeReader = require('javascript-barcode-reader')
const os = require('os')
const download = require('downloadjs')
const dataPaths = require('./data-paths')
// const javascriptBarcodeReader = require('../../../Javascript-Barcode-Reader/src')

/**
 * Create worker process equal to cpu cores
 *
 * @returns {Array} array of child process forks
 */
async function createWorkerProcesses(imagesCount) {
  const WORKERS = []

  let NO_OF_CORES = await new Promise(resolve => {
    switch (os.platform()) {
      case 'win32':
        childProcess.exec('wmic CPU Get NumberOfCores', {}, (err, out) => {
          resolve(
            parseInt(
              out
                .replace(/\r/g, '')
                .split('\n')[1]
                .trim(),
              10,
            ),
          )
        })
        break
      case 'darwin':
      case 'linux':
        childProcess.exec('getconf _NPROCESSORS_ONLN', {}, (err, out) => {
          resolve(parseInt(out, 10))
        })
        break
      case 'freebsd':
      case 'openbsd':
        childProcess.exec('getconf NPROCESSORS_ONLN', {}, (err, out) => {
          resolve(parseInt(out, 10))
        })
        break
      case 'sunos':
        childProcess.exec(
          'kstat cpu_info|grep core_id|sort -u|wc -l',
          {},
          (err, out) => {
            resolve(parseInt(out, 10))
          },
        )
        break
      default:
        resolve()
        break
    }
  })

  NO_OF_CORES = Math.min(NO_OF_CORES || os.cpus().length / 2, imagesCount)

  // If available ram is less than 500MB, use only two worker processes
  if ((os.totalmem() - os.freemem()) / (1024 * 1024 * 1024) < 0.5) {
    NO_OF_CORES = 2
  }

  for (let i = 0; i < NO_OF_CORES; i += 1) {
    WORKERS.push(
      childProcess.fork(`${__dirname}/processTaskWorker.js`, [], {
        silent: true,
      }),
    )
  }

  return WORKERS
}

/**
 * Extracts position & dimensions of objects from SVG design File
 *
 * @param {String} designFilePath Path to the svg design file
 * @returns {Object} JSON object
 */
async function getDesignData(dir) {
  const designData = {
    questions: {},
  }
  const ROLL_NO_PATTERN = new RegExp(/rollnobarcode/gi)
  const QUESTION_PATTERN = new RegExp(/(q[1-9][0-9]?[ad])\b/gi)

  const $ = cheerio.load(fs.readFileSync(dir, 'utf8'))
  const svgViewBox = $('svg')[0].attribs.viewBox.split(' ')

  designData.width = Math.ceil(svgViewBox[2] - svgViewBox[0])
  designData.height = Math.ceil(svgViewBox[3] - svgViewBox[1])

  let gotRollNo = false
  let x
  let y
  let rx
  let ry
  let width
  let height
  let left
  let top

  const groups = $('g')
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i]

    const title = $(group)
      .find('title')
      .first()
      .html()
      .trim()
      .toLowerCase()

    const isQuestionGroup = QUESTION_PATTERN.test(title)
    const isRollNoGroup =
      isQuestionGroup || gotRollNo ? false : ROLL_NO_PATTERN.test(title)

    if (isQuestionGroup || isRollNoGroup) {
      const transform = $(group)
        .attr('transform')
        .replace(/(translate)|\(|\)/gi, '')
        .split(',')
        .map(val => parseFloat(val))

      const rect = $(group)
        .find('rect')
        .first()

      left = parseFloat(rect.attr('x'))
      top = parseFloat(rect.attr('y'))

      rx = parseFloat(rect.attr('rx')) || 0
      ry = parseFloat(rect.attr('ry')) || 0

      x = left - rx + transform[0]
      y = top - ry + transform[1]

      width = parseFloat(rect.attr('width')) + rx
      height = parseFloat(rect.attr('height')) + ry
    }

    if (isQuestionGroup) {
      const optionTitle = title.slice(-1)
      const questionNumber = title.slice(0, -1)

      if (!designData.questions[questionNumber]) {
        designData.questions[questionNumber] = {}
      }

      if (optionTitle === 'a') {
        designData.questions[questionNumber].x1 = x
        designData.questions[questionNumber].y1 = y
      } else {
        designData.questions[questionNumber].x2 = x + width
        designData.questions[questionNumber].y2 = y + height
      }
    }

    if (isRollNoGroup) {
      designData.rollNo = { x1: x, y1: y, x2: x + width, y2: y + height }
      gotRollNo = true
    }
  }

  return designData
}

/**
 * Return a list of valid image format files from the provided path
 *
 * @param {String} path Path to sarch for images
 * @param {Array.<String>} format Array of extensions of valid image formats
 * @returns {Array.<String>} List of file paths
 */
function getImagePaths(dir) {
  const formats = [
    'png',
    'jpg',
    'jpeg',
    'jpe',
    // 'jfif',
    'gif',
    'tif',
    'tiff',
    'bmp',
    // 'dib',
  ]

  return fastGlob(`${dir}/*.{${formats.join(',')}}`, { onlyFiles: true })
}

/**
 * Returns a trained neural network function
 *
 * @returns {Function} Neural network function
 */
function getNeuralNet(src) {
  const net = new brain.NeuralNetwork()

  return net.fromJSON(
    JSON.parse(fs.readFileSync(src || dataPaths.trainingData)),
  )
}

/**
 *
 *
 * @param {Object} designData A JSON Object containing information about the position, width, height of elements in svg design file (available from utiltities/getDesignData)
 * @param {String} path Path of scanned image file
 * @param {Object=} resultsData Path to csv file for training data
 * @param {Number=} rollNo Roll no of the current scanned image
 * @returns {Object} {title: {String}, data: {buffer}}
 */
async function getQuestionsData(designData, img, resultsData, rollNo) {
  const SCALE = 0.25
  const IS_TEST_DATA = resultsData && rollNo

  return new Promise((resolveCol, rejectCol) => {
    img.resize(designData.width * SCALE).max()

    const promises = []
    // extract all questions portions
    Object.keys(designData.questions).forEach(title => {
      const p = new Promise(resolve => {
        const q = designData.questions[title]

        img
          .extract({
            left: Math.floor(q.x1 * SCALE),
            top: Math.floor(q.y1 * SCALE),
            width: Math.ceil((q.x2 - q.x1) * SCALE),
            height: Math.ceil((q.y2 - q.y1) * SCALE),
          })
          // .png()
          // .toFile(path.join(dataPaths.tmp, `${rollNo}-${title}.png`), err => {
          //   if (err) console.log(err)
          //   resolve()
          // })
          .toBuffer({ resolveWithObject: true })
          .then(({ data }) => {
            const binaryData = []

            for (let i = 0; i < data.length; i += 3) {
              const r = i
              const g = i + 1
              const b = i + 2
              const avg = Math.ceil((data[r] + data[g] + data[b]) / 3)
              const threshold = 15

              if (avg <= 80) {
                // black pixel
                binaryData.push(0)
              } else if (
                data[r] <= avg + threshold &&
                data[r] >= avg - threshold &&
                (data[g] <= avg + threshold && data[g] >= avg - threshold) &&
                (data[b] <= avg + threshold && data[b] >= avg - threshold)
              ) {
                // grey pixel
                binaryData.push(1)
              } else {
                // color pixel
                binaryData.push(0)
              }
            }

            if (IS_TEST_DATA) {
              // for training data
              if (resultsData[rollNo] && resultsData[rollNo][title] !== '*') {
                const o = {}
                o[resultsData[rollNo][title]] = 1

                resolve({ input: binaryData, output: o })
              } else {
                resolve(false)
              }
            } else {
              // for processing data
              resolve({ title, data: binaryData })
            }
          })
      })

      promises.push(p)
    })

    Promise.all(promises)
      .then(res => {
        resolveCol(res)
      })
      .catch(err => {
        rejectCol(err)
      })
  })
}

/**
 *
 *
 * @param {Object} designData A JSON Object containing information about the position, width, height of elements in svg design file (available from utiltities/getDesignData)
 * @param {String} path Path of scanned image file
 * @returns {String} Roll Number
 */
async function getRollNoFromImage(designData, img) {
  const metadata = await img.metadata()
  const rollNoPos = designData.rollNo
  const ratio = metadata.width / designData.width
  const width = Math.ceil((rollNoPos.x2 - rollNoPos.x1) * ratio)
  const height = Math.ceil((rollNoPos.y2 - rollNoPos.y1) * ratio)

  const { data } = await img
    .extract({
      left: Math.floor(rollNoPos.x1 * ratio),
      top: Math.floor(rollNoPos.y1 * ratio),
      width,
      height,
    })
    .toBuffer({ resolveWithObject: true })

  // add missing channel
  const newData = []
  for (let i = 0; i < data.length; i += 3) {
    newData.push(data[i])
    newData.push(data[i + 1])
    newData.push(data[i + 2])
    newData.push(255)
  }

  return javascriptBarcodeReader(
    { data: newData, width, height },
    { barcode: 'code-39' },
  )
}

/**
 *
 *
 * @param {String} str JSON object or JSON file path
 * @param {Boolean} isPath True for path
 * @param {Boolean} isKey True if the CSV file is answer key file
 * @returns {Object} CSV String
 */
async function CSVToJSON(str, isPath, isKey) {
  const resultFile = isPath ? fs.readFileSync(str, 'utf8') : str
  const json = {}

  // extract rows and header names
  const rows = resultFile.split('\n')
  const headerValues = rows[0]
    .replace(/(\s)|(\.)|(-)|(_)/gi, '')
    .toLowerCase()
    .split(',')

  // extract index of roll no in header row
  const rollNoIndex = headerValues.indexOf('rollno')

  if (isKey) rows.length = 2
  // iterate rows but skips header row
  for (let i = 1; i < rows.length; i += 1) {
    const obj = {}
    const values = rows[i]
      .replace(/(\s)|(\.)|(-)|(_)/gi, '')
      .toLowerCase()
      .split(',')

    values.forEach((value, index) => {
      if (index !== rollNoIndex) {
        obj[headerValues[index]] = value
      }
    })

    if (isKey) {
      json.key = obj
    } else {
      const roll = values[rollNoIndex]

      if (roll) {
        json[roll] = obj
      }
    }
  }

  return json
}

/**
 *
 *
 * @param {String} str JSON object or JSON file path
 * @param {Boolean} isPath True for path
 * @returns {Object} CSV String
 */
function JSONToCSV(str, isPath) {
  const obj = isPath ? JSON.parse(fs.readFileSync(str, 'utf8')) : str

  let header = 'ROLL NO'
  let csv = ''

  // sort by roll number
  obj.sort((a, b) => Object.keys(a)[0] - Object.keys(b)[0])

  // parse to csv
  Object.values(obj).forEach((val, index) => {
    const [[rollno, keys]] = Object.entries(val)

    // eslint-disable-next-line
    csv += '\n'
    csv += rollno

    // sort by question no
    const keyEntries = Object.entries(keys).sort(
      (a, b) => a[0].replace('q', '') - b[0].replace('q', ''),
    )

    // append to csv
    for (let i = 0; i < keyEntries.length; i += 1) {
      if (i !== keyEntries.length) {
        csv += ','
      }

      csv += keyEntries[i][1].toUpperCase()

      if (index === 0) {
        header += `,${keyEntries[i][0].toUpperCase()}`
      }
    }
  })

  return `${header}${csv}`
}

/**
 * Exports JSON result data as CSV
 *
 * @param {Object} resultData
 */
async function exportResult(resultData) {
  const csv = await JSONToCSV(resultData)

  try {
    download(csv, 'result.csv', 'text/csv')
  } catch (error) {
    console.log('Result: ', csv)
  }
}

module.exports = {
  createWorkerProcesses,
  getDesignData,
  getImagePaths,
  getNeuralNet,
  getRollNoFromImage,
  CSVToJSON,
  JSONToCSV,
  getQuestionsData,
  exportResult,
}
