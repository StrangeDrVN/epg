import { Logger, Collection } from '@freearhey/core'
import { Storage } from '@freearhey/storage-js'
import epgGrabber, { EPGGrabber } from 'epg-grabber'
import epgParser from 'epg-parser'
import { Channel } from '../../models'
import { SITES_DIR } from '../../constants'
import { Option, program } from 'commander'
import axios from 'axios'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs-extra'
import dayjs from 'dayjs'

program
  .addOption(
    new Option('-u, --url <url>', 'M3U playlist URL from iptv-org/iptv')
      .makeOptionMandatory()
  )
  .addOption(
    new Option('-d, --days <number>', 'Number of days to look ahead')
      .default(2)
      .argParser((val) => parseInt(val, 10))
  )
  .parse()

interface SyncOptions {
  url: string
  days: number
}

const options: SyncOptions = program.opts()
const OUTPUT_DIR = path.join(process.cwd(), 'output')

async function main() {
  const logger = new Logger()
  logger.start('Starting M3U EPG Grabber Architecture...')

  // 1. Fetch and Parse M3U for tvg-ids
  logger.info(`Fetching M3U playlist from: ${options.url}`)
  let m3uContent = ''
  try {
    const response = await axios.get(options.url)
    m3uContent = response.data
  } catch (err: any) {
    logger.error(`Failed to fetch M3U: ${err.message}`)
    process.exit(1)
  }

  const targetTvgIds = extractTvgIds(m3uContent)
  logger.info(`Found ${targetTvgIds.size} unique tvg-id(s) inside the M3U playlist.`)

  // 2. Load all available channels across the project workspace registries
  const allWorkspaceChannels = await loadWorkspaceChannels()

  // 3. Intersect channels to only match the target M3U IDs
  const matchedChannels = new Collection<Channel>()
  const trackedXmltvIds = new Set<string>()

  allWorkspaceChannels.forEach((channel: Channel) => {
    if (channel.xmltv_id && targetTvgIds.has(channel.xmltv_id)) {
      const matchKey = `${channel.xmltv_id}:${channel.site}:${channel.lang}`
      if (!trackedXmltvIds.has(matchKey)) {
        trackedXmltvIds.add(matchKey)
        matchedChannels.add(channel)
      }
    }
  })

  if (matchedChannels.count() === 0) {
    logger.error('No overlapping channel mappings found between your M3U and local site targets!')
    process.exit(1)
  }

  // 4. Stash Yesterday's Programs from the Current Active XML Guide
  const activeGuidePath = path.join(OUTPUT_DIR, 'guide.xml')
  let historicalProgramsXml = ''

  if (await fs.pathExists(activeGuidePath)) {
    logger.info("Reading existing 'guide.xml' to extract historical programs...")
    try {
      const rawXmlData = await fs.readFile(activeGuidePath, 'utf-8')
      historicalProgramsXml = extractPastPrograms(rawXmlData, targetTvgIds)
    } catch (parseErr: any) {
      logger.info(`Could not process old guide for history retention: ${parseErr.message}`)
    }
  }

  // 5. Save dynamically filtered channel configuration file
  const xmlChannelsPayload = matchedChannels.all().map(c => {
    return `  <channel id="${c.xmltv_id}" site="${c.site}" site_id="${c.site_id}" lang="${c.lang}">${c.name}</channel>`
  }).join('\n')
  
  const rawXmlFileContent = `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${xmlChannelsPayload}\n</channels>`
  
  const outputStorage = new Storage(OUTPUT_DIR)
  await outputStorage.save('channels.xml', rawXmlFileContent)

  // 6. Manifest worker.json metadata structure
  const workerMetadata = {
    channels: 'channels.xml',
    guide: {
      xml: 'guide.xml',
      gzip: 'guide.xml.gz',
      json: 'guide.json'
    }
  }
  await outputStorage.save('worker.json', JSON.stringify(workerMetadata, null, 2))

  // 7. Invoke the grab pipeline natively
  logger.info(`Triggering grab engine to parse the next ${options.days} days...`)
  try {
    const grabCommand = `npx tsx scripts/commands/epg/grab.ts --channels "output/channels.xml" --output "output/guide.xml" --days ${options.days} --gzip --json`
    execSync(grabCommand, { stdio: 'inherit' })
  } catch (error) {
    logger.error('The core aggregator script encountered a hard error processing requests.')
    process.exit(1)
  }

  // 8. Stitch yesterday's historical XML blocks back into the fresh output
  if (historicalProgramsXml) {
    logger.info('Stitching historical program data back into the fresh guide matrix...')
    try {
      await mergeHistoryAndRebuildAllFormats(activeGuidePath, historicalProgramsXml, outputStorage)
      logger.success('All unified formats compiled completely including history logs!')
    } catch (mergeErr: any) {
      logger.error(`Failed to inject history blocks into target outputs: ${mergeErr.message}`)
    }
  } else {
    logger.success('Sync complete! (No historical data was found/merged this run).')
  }
}

function extractTvgIds(m3u: string): Set<string> {
  const ids = new Set<string>()
  const lines = m3u.split('\n')
  const tvgIdRegex = /tvg-id="([^"]+)"/i

  for (const line of lines) {
    if (line.startsWith('#EXTINF')) {
      const match = line.match(tvgIdRegex)
      if (match && match[1]) {
        ids.add(match[1].trim())
      }
    }
  }
  return ids
}

async function loadWorkspaceChannels() {
  const sitesStorage = new Storage(SITES_DIR)
  const files: string[] = await sitesStorage.list('**/*.channels.xml')
  const channels = new Collection<Channel>()

  for (const filepath of files) {
    const xml = await sitesStorage.load(filepath)
    const parsedChannels = EPGGrabber.parseChannelsXML(xml)
    const channelsFromXML = new Collection(parsedChannels).map(
      (channel: epgGrabber.Channel) => new Channel(channel.toObject())
    )
    channelsFromXML.forEach((channel: Channel) => {
      channels.add(channel)
    })
  }
  return channels
}

function extractPastPrograms(xmlContent: string, m3uTvgIds: Set<string>): string {
  const programRegex = /<program[\s\S]*?<\/program>/g
  const channelIdRegex = /channel="([^"]+)"/
  const startRegex = /start="(\d{14})/ 
  
  let match
  let historicalBlocks: string[] = []
  const rightNowString = dayjs().format('YYYYMMDDHHmmss')

  while ((match = programRegex.exec(xmlContent)) !== null) {
    const block = match[0]
    const channelMatch = block.match(channelIdRegex)
    const startMatch = block.match(startRegex)

    if (channelMatch && startMatch) {
      const channelId = channelMatch[1]
      const startTime = startMatch[1]

      // Keep it if it matches our active M3U filters AND its start block is older than right now
      if (m3uTvgIds.has(channelId) && startTime < rightNowString) {
        historicalBlocks.push(block)
      }
    }
  }
  return historicalBlocks.join('\n')
}

async function mergeHistoryAndRebuildAllFormats(guideXmlPath: string, historyXml: string, outputStorage: Storage) {
  let activeXml = await fs.readFile(guideXmlPath, 'utf-8')
  
  const closureIndex = activeXml.lastIndexOf('</tv>')
  if (closureIndex === -1) return

  const modifiedXml = activeXml.substring(0, closureIndex) + historyXml + '\n</tv>'
  await fs.writeFile(guideXmlPath, modifiedXml, 'utf-8')

  // Parse unified structure to regenerate guide.json perfectly
  const parsedData = epgParser.parse(modifiedXml)
  await outputStorage.save('guide.json', JSON.stringify(parsedData, null, 2))

  // Run a quick zip utility loop to regenerate the guide.xml.gz format out of the patched XML string
  const pako = require('pako')
  const bufferInput = Buffer.from(modifiedXml, 'utf-8')
  const compressedGzip = pako.gzip(bufferInput)
  await fs.writeFile(path.join(OUTPUT_DIR, 'guide.xml.gz'), compressedGzip)
}

main()
