const path = require('path')
const dataPaths = require('./data-paths')

/**
 * Import utilty functions
 */
const { processTask } = require('./processTaskWorker')
const {
  createWorkerProcesses,
  getDesignData,
  getImagePaths,
} = require('./index')

// result collection
let resultData = []
const verifyData = []

// default options
const DEFAULTS = [
  path.join(dataPaths.testData, 'design.svg'),
  path.join(dataPaths.testData, 'images'),
  true, // disable for testing processTask using in-process
]
// store reference to all workers
let WORKER_PROCESSES

/**
 * Stops all worker processes
 */
function stop() {
  for (let i = 0; i < WORKER_PROCESSES.length; i += 1) {
    if (WORKER_PROCESSES[i].connected) {
      WORKER_PROCESSES[i].send({
        stop: true,
      })
    }
  }
}

/**
 * Start processing scanned image files to get result
 *
 * @param {Function} listner Callback function for updates
 * @param {String?} designFilePath design file path
 * @param {String} imagesDirectory scanned images directory
 * @param {String?} keyfile File path of key file/image
 * @param {Boolean} useWorkers Enable parrallel processing
 *
 * @returns {Object} {totalImages, totalWorkers}
 */
async function start(
  listner,
  designFilePath = DEFAULTS[0],
  imagesDirectory = DEFAULTS[1],
  keyfile,
  useWorkers = DEFAULTS[2],
) {
  // reset result collection
  resultData = []

  const imagePaths = await getImagePaths(imagesDirectory)
  const designData = await getDesignData(designFilePath)

  // For testing only
  if (!useWorkers) {
    processTask(designData, imagePaths).then(res => {
      console.log(res)
    })
  } else {
    const TOTAL_IMAGES = imagePaths.length
    WORKER_PROCESSES = await createWorkerProcesses(TOTAL_IMAGES)
    const TOTAL_PROCESS = WORKER_PROCESSES.length
    const STEP = Math.floor(TOTAL_IMAGES / TOTAL_PROCESS)

    for (let i = 0; i < TOTAL_PROCESS; i += 1) {
      const startIndex = i * STEP
      const endIndex = i === TOTAL_PROCESS - 1 ? TOTAL_IMAGES : (i + 1) * STEP
      const worker = WORKER_PROCESSES[i]

      // initiate processing
      worker.send({
        designData,
        imagePaths: imagePaths.slice(startIndex, endIndex),
      })

      worker.on('message', m => {
        // collect result from process
        if (m.completed) {
          resultData.push(m.result)

          // check if all process have returned result
          if (resultData.length === TOTAL_PROCESS) {
            // report view of completion
            listner({
              completed: true,
            })

            // prepare result array
            resultData = resultData.reduce(
              (prev, curr) => prev.concat(curr),
              [],
            )

            // Initiate verification process
            console.log('result: ', resultData)
            console.log('verify: ', verifyData)

            // TODO: get inputs for verification data
            // TODO: export result data
          }
        } else if (m.verify) {
          verifyData.push(m)
        }

        // to display status in view
        if (listner && !m.completed) {
          /* eslint-disable*/
          // strip extra data from message object
          m.result = null
          m.verify = null
          /* eslint-enable */
          listner(m)
        }
      })

      // logging
      worker.stdout.on('data', data => {
        if (listner) {
          listner({
            log: data.toString(),
          })
        } else {
          console.log(data.toString())
        }
      })

      // error
      worker.stderr.on('data', data => {
        if (listner) {
          listner({
            error: data.toString(),
          })
        } else {
          console.log(data.toString())
        }
      })
    }
  }

  return {
    totalImages: imagePaths.length,
    totalWorkers: WORKER_PROCESSES.length,
  }
}

module.exports = {
  start,
  stop,
}
