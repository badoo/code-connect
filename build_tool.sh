#!/bin/bash -e
# OVERVIEW: Downloads and prepares Code Connect CLI, builds and packages figma CLI
# USAGE: ./build_tool.sh [xcframework_output_path]
# SIDE EFFECTS: Creates temporary directory, clones repository, installs dependencies,
#               builds CLI, and moves generated files to specific locations

SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
pushd "$SCRIPT_DIR" > /dev/null
trap "popd > /dev/null" EXIT

mkdir release

cd cli

# Install dependencies and build
npm install
npm run bundle:cli:mac:arm64

# Move the generated file to the root and rename it
mv bundle-cli/figma-mac-arm64 "$SCRIPT_DIR/release/figma" || echo "Warning: figma-mac-arm64 file not found"
cd ..

echo "✅ Code Connect CLI prepared successfully"

echo "🔄 Building figma CLI"

swift build \
    --product figma-swift \
    --package-path ./swiftui/ \
    --configuration release \
    --arch arm64
echo "✅ Build succeeded for figma-swift"

echo "🔄 Packaging CLI..."
cp -f \
    ./.build/arm64-apple-macosx/Release/figma-swift \
    "$SCRIPT_DIR/release/figma-swift"

echo "✅ Packaging succeeded for figma-swift"

echo "🔄 Building Figma SDK for iOS..."

set -x
set -e

# Pass scheme name as the first argument to the script
NAME=Figma

# Build the scheme for all platforms that we plan to support
for PLATFORM in "iOS" "iOS Simulator"; do

    case $PLATFORM in
    "iOS")
    RELEASE_FOLDER="Release-iphoneos"
    ;;
    "iOS Simulator")
    RELEASE_FOLDER="Release-iphonesimulator"
    ;;
    esac

    ARCHIVE_PATH=$RELEASE_FOLDER

    # Rewrite Package.swift so that it declaras dynamic libraries, since the approach does not work with static libraries
    perl -i -p0e 's/type: .static,//g' ./Package.swift
    perl -i -p0e 's/type: .dynamic,//g' ./Package.swift
    perl -i -p0e 's/(library[^,]*,)/$1 type: .dynamic,/g' ./Package.swift

    xcodebuild archive -workspace ./ -scheme $NAME \
            -destination "generic/platform=$PLATFORM" \
            -archivePath $ARCHIVE_PATH \
            -derivedDataPath ".build" \
            SKIP_INSTALL=NO BUILD_LIBRARY_FOR_DISTRIBUTION=YES

    FRAMEWORK_PATH="$ARCHIVE_PATH.xcarchive/Products/usr/local/lib/$NAME.framework"
    MODULES_PATH="$FRAMEWORK_PATH/Modules"
    mkdir -p $MODULES_PATH

    BUILD_PRODUCTS_PATH=".build/Build/Intermediates.noindex/ArchiveIntermediates/$NAME/BuildProductsPath"
    RELEASE_PATH="$BUILD_PRODUCTS_PATH/$RELEASE_FOLDER"
    SWIFT_MODULE_PATH="$RELEASE_PATH/$NAME.swiftmodule"
    RESOURCES_BUNDLE_PATH="$RELEASE_PATH/${NAME}_${NAME}.bundle"

    # Copy Swift modules
    if [ -d $SWIFT_MODULE_PATH ] 
    then
        cp -r $SWIFT_MODULE_PATH $MODULES_PATH
    else
        # In case there are no modules, assume C/ObjC library and create module map
        echo "module $NAME { export * }" > $MODULES_PATH/module.modulemap
        # Copy headers
        HEADERS_PATH="$RELEASE_PATH/include/$NAME"
        if [ -d "$HEADERS_PATH" ]; then
            mkdir -p "$FRAMEWORK_PATH/Headers"
            cp -R "$HEADERS_PATH/" "$FRAMEWORK_PATH/Headers/"
        else
            echo "Warning: No headers found at $HEADERS_PATH"
        fi
    fi

    # Copy resources bundle, if exists 
    if [ -e $RESOURCES_BUNDLE_PATH ] 
    then
        cp -r $RESOURCES_BUNDLE_PATH $FRAMEWORK_PATH
    fi

done

xcodebuild -create-xcframework \
-framework Release-iphoneos.xcarchive/Products/usr/local/lib/$NAME.framework \
-framework Release-iphonesimulator.xcarchive/Products/usr/local/lib/$NAME.framework \
-output "$SCRIPT_DIR/release/$NAME.xcframework"

# Move back to the root directory
cd "$SCRIPT_DIR"

# Remove the .xcarchive files after creating the xcframework
rm -rf Release-iphoneos.xcarchive Release-iphonesimulator.xcarchive

echo "✅ Packaging succeeded for Figma SDK for iOS"

echo "✅ All operations completed successfully"