import * as program from 'commander'
// @ts-ignore
import cf from 'colorfy'
import { resolve } from 'path'

// @ts-ignore
import { fetchExtInfoFromClonedRepo } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { addNewExtension, writeToExtensionsFile } from 'publish-to-open-vsx/add-extension'
// @ts-ignore
import { onDidAddExtension, readExtensionsFromFile } from 'publish-to-open-vsx/add-extension'
import { VSExtension } from './types/openvsx'
import {
  deprecatedExtensionsMap,
  Extension,
  getExtensionThatNotPresentOnOpenVSX,
  getExtInfoFromMicrosoftStore,
  getRepoByVsixManifest,
  isExtensionPack,
} from './utils'

// vymarkov.nodejs-devops-extension-pack
// jabacchetta.vscode-essentials
// mubaidr.vuejs-extension-pack
// formulahendry.auto-complete-tag
// afractal.node-essentials

const getExtensionNamesFromFile = async (extensionsFile: string) => {
  const { extensions }: { extensions: { id: string }[] } = await readExtensionsFromFile(
    extensionsFile
  )
  return (extensions ?? []).map(itm => itm.id)
}

const addExtensions = async (notAddedExtensions: VSExtension[], extensionsFile: string) => {
  if (notAddedExtensions.length === 0) {
    return
  }
  const filepath = resolve(process.cwd(), extensionsFile)
  const { extensions } = await readExtensionsFromFile(filepath)
  const repos = notAddedExtensions.map(itm => itm.repoUrl)

  const extensionsToAdd = []
  for (const repository of repos) {
    const resp = await fetchExtInfoFromClonedRepo(repository, {})
    await addNewExtension(resp.extension, resp.package, extensions)
    extensionsToAdd.push(resp.extension)
  }
  extensionsToAdd.forEach(extension => onDidAddExtension(extension))
  await writeToExtensionsFile(extensions, extensionsFile)
}

program
  .version('0.0.1')
  .command('add <extension-name> [extensions.json]')
  .description(
    'add extension or extension pack to extension.json to publish to Open VSX, by default command adds extensions if pack meet all conditions only'
  )
  .action(async (name: string, extensionsFile: string, program) => {
    try {
      const extPackInfo: Extension = await getExtInfoFromMicrosoftStore(name)
      const repo = await getRepoByVsixManifest(extPackInfo)
      const extensionsFromFile: string[] = await getExtensionNamesFromFile(extensionsFile)

      if (await isExtensionPack(name)) {
        const {
          all,
          notFoundWithlicense,
          notFoundWithoutlicense,
          deprecatedExtensions,
          dontMeetConditions,
        } = await getExtensionThatNotPresentOnOpenVSX(name)

        if (dontMeetConditions.length > 0) {
          console.log(
            'Some of extensions are not open source thus can not published to Open VSX from https://github.com/open-vsx/publish-extensions'
          )
          console.log('You need to ask authors to publish extension by himself:')
          dontMeetConditions
            .filter(itm => all.has(itm))
            .map(itm => all.get(itm))
            .forEach(itm => {
              if (itm?.msmarketplaceUrl) {
                console.log(
                  cf()
                    .green(itm?.msmarketplaceUrl)
                    .colorfy()
                )
              } else if (itm?.repoUrl) {
                console.log(
                  cf()
                    .green(itm?.repoUrl)
                    .colorfy()
                )
              }
            })
        }
        console.log(' ')

        if (deprecatedExtensions.length > 0) {
          console.log(
            'Some of extensions are deprecated, you have to update extension ids in order to publish the extension pack.'
          )
          for (const id of deprecatedExtensions) {
            console.log(
              `Extension id should be updated from ${cf()
                .red(id)
                .colorfy()} to ${cf()
                .green(deprecatedExtensionsMap.get(id))
                .colorfy()}`
            )
            console.log(
              `Please ask ext pack\'s authors to update extension id at ${cf()
                .green(repo.repoUrl + '/issues')
                .colorfy()}`
            )
          }
        }
        console.log(' ')

        if (notFoundWithlicense.length > 0) {
          console.log('See below extensions that are not present in Open VSX marketplace:')
          console.log(
            `extensions with license (${notFoundWithlicense.length}):`,
            notFoundWithlicense
          )
        }

        if (notFoundWithoutlicense.length > 0) {
          console.log(
            `extensions without license (${notFoundWithoutlicense.length}):`,
            notFoundWithoutlicense
          )
          console.log(
            'Extensions without license CAN NOT BE uploaded to Open VSX registry, license must be present'
          )
        }

        const allConditionsAreMet =
          !notFoundWithlicense.length &&
          !notFoundWithoutlicense.length &&
          !deprecatedExtensions.length &&
          !dontMeetConditions.length
        if (allConditionsAreMet) {
          console.log('All extensions are present in Open VSX marketplace.')
        }

        if (allConditionsAreMet || program.addExtensionsWithlicense) {
          const extensionsToAdd = notFoundWithlicense.filter(
            itm => !extensionsFromFile.find(name => itm.name === name)
          )

          if (extensionsToAdd.length > 0) {
            console.log(`Adding extensions with defined license to ${extensionsFile}`)
            await addExtensions(extensionsToAdd, extensionsFile)
          }
        }
      } else {
        console.log('Adding extension by name is not supported!')
      }
    } catch (err) {
      console.error(err)
      console.error(err.message)
    }
  })
  .option(
    '--add-extensions-with-license',
    'Add extensions that have license even if extension pack contains extensions without license'
  )
  .option('--extension-name <string>', "Extension's name to add")
  .on('--help', () => {
    console.log('Examples:')
    console.log('')
    console.log('  $ -n vymarkov.nodejs-devops-extension-pack')
  })
  .parse(process.argv)
