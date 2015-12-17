/*
  Copyright (c) Microsoft. All rights reserved.  
  Licensed under the MIT license. See LICENSE file in the project root for full license information.
*/

var path = require('path'),
    fs = require('fs'),
    glob = require('glob'),
	Q = require ('q'),
    nodeManager = require('./lib/node-manager.js'),
    taskLibrary = require('./lib/vso-task-lib-proxy.js');

// Task does the following:
// 1. Setup node
// 2. If iOS, fix project and call bundle directly
// 3. If Android, update react-native CLI calls in react.gradle to use node version

var buildSourceDirectory = taskLibrary.getVariable('build.sourceDirectory') || taskLibrary.getVariable('build.sourcesDirectory');
//Process working directory
var workingDirectory = taskLibrary.getInput('cwd', /*required*/ false) || buildSourceDirectory;
taskLibrary.cd(workingDirectory);
// Target platform
var platform = taskLibrary.getInput("platform",true);

if(!fs.existsSync(path.join(workingDirectory, 'node_modules', 'react-native'))) {
    taskLibrary.debug('react-native npm package not installed.');
    console.error('React Native npm package (react-native) not installed locally. Add the "npm" task to your build definition with the "install" command and "--no-optional --only=prod" under Advanced > Arguments.');
    taskLibrary.exit(1);
} else {
    nodeManager.setupMinNode('4.0.0','4.2.3', false)
        .then(fixProjects)
        .then(function() {
            console.log('Success: Project ready for native build.')
        })
        .fail(function (err) {
            console.error(err.message);
            taskLibrary.debug('taskRunner fail');
            taskLibrary.exit(1);
        });    
}



function fixProjects()
{
    if(platform == 'ios') {
        // Fix project and call bundle
        fixXcproj();
        return bundle();
    } else if(platform == 'android') {
        // No need to call bundle for Android but need to tweak the project a bit
        return fixGradleProj();
    } else {
        throw 'Platform ' + platform + 'not supported.';
    }
    process.env.BUILD_IS_FOR_CI = "true";   
    return;
}

function fixGradleProj() {
    // We can't easily call "bundle" outside of the build process since the target build folder is wiped out as a result of a native build
    // Bundle is part of the Gradle build process and fortunatley does not start up the packager via the build command - but we do need to set things up to use specific node version
    // As a result we instead need to simply update the reference to the node version in react.gradle and then let the build do its thing
    var reactGradleFile = path.join(workingDirectory,'android','app','react.gradle');
    var reactGradleContents = fs.readFileSync(reactGradleFile, 'utf8');
    if(reactGradleContents.indexOf('"react-native", "bundle",') < 0) {
        taskLibrary.debug(reactGradleFile + ' already patched.');                     
    } else {   
        taskLibrary.debug('Platform is Android - attempting to patch ' + reactGradleFile + ' to use specified node verison.');
        var nodePath = path.join(nodeManager.getNodePath(), 'node');
        var cliPath = path.join(workingDirectory, 'node_modules', 'react-native', 'local-cli','cli.js').replace(/\\/g,'\\\\' );
        var newContents = reactGradleContents.replace(/"react-native",\s?"bundle",/gm, '"'+ nodePath.replace(/\\/g,'\\\\' ) + '", "' + cliPath + '", "bundle",');        
        fs.writeFileSync(reactGradleFile, newContents,'utf8');                
    }       
}

function fixXcproj() {
    // The default behavior of React Native iOS is to start up the packager server on build.  The problem with this
    // behavior is that it is not only unncessisary but also will _hang_ VSTS since it will wait for the process
    // to terminate before marking the build complete assuming that there is some lagging cleanup task.  
    // While this is a good assumption generally, it causes problems here so we will trigger offline bundling manually
    // and update the packager server startup script to only start if an environment var is not set. 
    //
    // **TODO: Submit PR to react-native project so we no longer have to do this. Sync up detection if a patch has
    //         already been applied so that it is not done for React Native projects after the PR has been accepted.
    //
    // Look through all xpbproj files and add in reference to skip if running in CI env
    var projFiles = glob.sync('ios/*.xcodeproj/project.pbxproj');
    projFiles.forEach(function(proj) {
        taskLibrary.debug('Platform is iOS - attempting to patch ' + proj + ' for CI env.');
        var pbxprojContents = fs.readFileSync(proj, 'utf8');
        var packagerShell = pbxprojContents.match(/".*react-native-xcode.sh.*";/mi);            
        if(packagerShell) {
            packagerShell=packagerShell[0].substring(1, packagerShell[0].length-2);
            if(packagerShell.indexOf('BUILD_IS_FOR_CI+xxx') < 0) {
                taskLibrary.debug('Patching ' + proj + '.');                            
                var newShell='if [-z \\"${BUILD_IS_FOR_CI+xxx}\\" ]\\nthen\\n'+ packagerShell + '\\nfi';
                taskLibrary.debug(newShell);
                pbxprojContents=pbxprojContents.replace(packagerShell, newShell);           
                fs.writeFileSync(proj,pbxprojContents,'utf8');                
            } else {
                taskLibrary.debug(proj + ' already patched.');            
            }
        } else {
            taskLibrary.debug(proj + ' does not require patching.');                            
        }
    });
    // Match react native node module (big hack)
    taskLibrary.debug('Platform is iOS - attempting to patch ' + reactProj + ' for CI env.');
    var reactProj = path.join(workingDirectory,'node_modules','react-native','React','React.xcodeproj','project.pbxproj');
    var pbxprojContents = fs.readFileSync(reactProj, 'utf8');
    var reactPackager = pbxprojContents.match(/".*launchPackager.command.*";/mi);
    if(reactPackager) {
        reactPackager=reactPackager[0].substring(1, reactPackager[0].length-2);
        if(reactPackager.indexOf('BUILD_IS_FOR_CI+xxx') < 0) {
            taskLibrary.debug('Patching ' + reactProj + '.');                            
            var newShell='if [-z \\"${BUILD_IS_FOR_CI+xxx}\\" ]\\nthen\\n'+ reactPackager + '\\nfi';
            taskLibrary.debug(newShell);
            pbxprojContents=pbxprojContents.replace(reactPackager, newShell);           
            fs.writeFileSync(reactProj,pbxprojContents,'utf8');                
        } else {
            taskLibrary.debug(reactProj + ' already patched.');            
        }
    } else {
        taskLibrary.debug(reactProj + ' does not require patching.');                            
    }        
}

function bundle()
{
    var entryFile = taskLibrary.getInput("entryFile",true);
    var bundleOutput = taskLibrary.getInput("bundleOutput",true);
    var devFlag = (taskLibrary.getInput('devFlag') == 'true');
    var bundleCommand = new taskLibrary.ToolRunner(taskLibrary.which('node', true));
    bundleCommand.arg([path.join('node_modules','react-native','local-cli','cli.js'), 'bundle', '--platform', platform, '--entry-file', entryFile, '--bundle-output', bundleOutput, '--dev' , devFlag]);

    var transformer = taskLibrary.getInput('transformer',false);
    if(transformer && transformer !== '' && transformer != buildSourceDirectory) {
        bundleCommand.arg(['--transformer', transformer]);        
    }
  
    var sourcemapOutput = taskLibrary.getInput('sourcemapOutput',false);
    if(sourcemapOutput && sourcemapOutput !== '' && sourcemapOutput != buildSourceDirectory) {
        bundleCommand.arg(['--sourcemap-output', sourcemapOutput]);        
    }

    var assetsDest = taskLibrary.getInput('assetsDest',false);
    if(assetsDest && assetsDest !== '' && assetsDest != buildSourceDirectory) {
        if(!fs.existsSync(assetsDest)) {
            var xcassetDirs = glob.sync(assetsDest);
            if(xcassetDirs && xcassetDirs.length >0 ) {
                assetsDest = xcassetDirs[0]; 
            }
        }
        bundleCommand.arg(['--assets-dest', assetsDest]);        
    }

    var moreArgs = taskLibrary.getInput('moreArgs',false);
    if(moreArgs && moreArgs !== '') {
        bundleCommand.arg(moreArgs);        
    }
    
    return bundleCommand.exec();
}
